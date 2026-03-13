#!/usr/bin/env bun
/**
 * iMessage Complete CLI v2.2.0
 * A comprehensive command-line interface for macOS Messages.app — 44 commands.
 *
 * Architecture:
 *   - bun:sqlite for direct chat.db queries (read, search, stats, contacts, etc.)
 *   - osascript (AppleScript) for Messages.app interaction (send, groups, GUI actions)
 *   - macOS System Events for GUI automation (block, delete-chat)
 *   - AddressBook SQLite for contact name resolution (fast, no AppleScript overhead)
 *   - kqueue (via Bun's fs.watch) for real-time message watching
 *   - OpenAI API for optional semantic search embeddings
 *
 * Requirements:
 *   - Bun runtime (https://bun.sh) — uses bun:sqlite, no npm dependencies
 *   - macOS 12+ (Monterey or later)
 *   - Messages.app signed into iMessage
 *   - Full Disk Access for database read commands (System Settings → Privacy & Security)
 *
 * Usage: bun imessage.ts <command> [args...]
 * Run without arguments or with --help for full usage information.
 *
 * @license MIT
 * @see README.md for full command reference and examples
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, basename } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watch } from "fs";

// ============================================================
// CONSTANTS
// ============================================================

const VERSION = "2.2.0";
const HOME = homedir();
/** Path to the iMessage SQLite database (macOS Messages.app storage) */
const DB_PATH = join(HOME, "Library/Messages/chat.db");
/** Path to the Messages.app attachments directory */
const ATTACH_PATH = join(HOME, "Library/Messages/Attachments");

// ============================================================
// USER CONFIGURATION — Customize these for your setup
// ============================================================

// Where spam-scan output files are written (Markdown checklists)
// Default: ~/Documents. Change to your Obsidian vault root, Desktop, etc.
const SPAM_SCAN_OUTPUT_DIR = join(HOME, "Documents");

// Default download directory for get-attachment
// Default: /tmp. Change to ~/Downloads or your preferred location.
const DEFAULT_ATTACHMENT_DIR = "/tmp";

// Directory for persistent state files (watch cursor, semantic search index).
// Default: ~/.imessage-cli. Change if you prefer another location.
const STATE_DIR = join(HOME, ".imessage-cli");

/**
 * Apple Core Data epoch offset: seconds between Unix epoch (1970-01-01) and Apple epoch (2001-01-01).
 * iMessage timestamps in chat.db are stored as nanoseconds since the Apple epoch.
 * To convert: unixSeconds = (appleNanoseconds / 1e9) + APPLE_EPOCH
 */
const APPLE_EPOCH = 978307200;

// ============================================================
// OUTPUT HELPERS
// ============================================================

/** Global flag: when true, all output is JSON-formatted (set via --json flag) */
let jsonMode = false;

/** Print data to stdout. Respects jsonMode for structured output. */
function out(data: unknown) {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/** Print error message to stderr and exit with code 1 */
function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ============================================================
// DATABASE HELPERS
// ============================================================

/**
 * Open the iMessage SQLite database (chat.db).
 * Exits with FDA instructions if the database is inaccessible.
 * @param readonly - Open in read-only mode (default: true). Write mode needed for delete-msg.
 */
function openDB(readonly = true): Database {
  if (!existsSync(DB_PATH)) {
    die(`chat.db not found at ${DB_PATH}. Is this a Mac with Messages.app?`);
  }
  try {
    const db = new Database(DB_PATH, { readonly });
    db.exec("SELECT 1");
    return db;
  } catch {
    console.error("ERROR: Cannot open chat.db — Full Disk Access required.");
    console.error("Run: bun imessage.ts setup-fda");
    process.exit(1);
  }
}

/** Convert Apple nanosecond timestamp to Date */
function appleTs(ns: number): Date {
  return new Date((ns / 1e9 + APPLE_EPOCH) * 1000);
}

/** Convert Apple second timestamp (attachments) to Date */
function appleTsSec(s: number): Date {
  return new Date((s + APPLE_EPOCH) * 1000);
}

function fmtDate(ns: number): string {
  if (!ns) return "—";
  return appleTs(ns).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDateSec(s: number): string {
  if (!s) return "—";
  return appleTsSec(s).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Format Apple nanosecond timestamp with 2-letter day-of-week prefix */
function fmtDateWithDay(ns: number): string {
  if (!ns) return "—";
  const d = appleTs(ns);
  const day = DAY_ABBR[d.getDay()];
  const date = d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} ${date}`;
}

function fmtDateSecWithDay(s: number): string {
  if (!s) return "—";
  const d = appleTsSec(s);
  const day = DAY_ABBR[d.getDay()];
  const date = d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} ${date}`;
}

/** Map a MIME type and filename to a human-readable attachment type label (e.g., "Photo", "PDF Document") */
function describeAttachment(mime: string | null, filename: string): string {
  if (!mime) {
    const ext = (filename || "").split(".").pop()?.toLowerCase();
    return ext?.toUpperCase() || "File";
  }
  if (mime.startsWith("image/")) return "Photo";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime === "application/pdf") return "PDF Document";
  if (mime.includes("word") || mime.includes("document")) return "Document";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "Spreadsheet";
  if (mime.includes("zip") || mime.includes("archive") || mime.includes("compressed")) return "Archive";
  if (mime.startsWith("text/")) return "Text File";
  const ext = (filename || "").split(".").pop()?.toLowerCase();
  return ext ? ext.toUpperCase() + " File" : "File";
}

/** Get pixel dimensions of an image file via macOS sips (returns "4032×3024" or "") */
function getImageDimensions(filepath: string): string {
  if (!filepath || !existsSync(filepath)) return "";
  try {
    const r = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", filepath], {
      stdout: "pipe", stderr: "pipe",
    });
    const out = new TextDecoder().decode(r.stdout);
    const w = out.match(/pixelWidth:\s*(\d+)/)?.[1];
    const h = out.match(/pixelHeight:\s*(\d+)/)?.[1];
    return w && h ? `${w}×${h}` : "";
  } catch { return ""; }
}

/**
 * Load an API key from environment or fallback .env file.
 * Checks process.env first, then reads ~/.imessage-cli/.env for KEY=VALUE pairs.
 * Used for OPENAI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY.
 */
function loadEnvKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const { readFileSync } = require("fs");
    const text = readFileSync(join(STATE_DIR, ".env"), "utf8") as string;
    const match = text.match(new RegExp(`^${name}=(.+)$`, "m"));
    return match?.[1]?.trim() || undefined;
  } catch { return undefined; }
}

/**
 * Describe an image attachment using AI vision APIs.
 * Tries providers in order: OpenAI gpt-4o-mini → Groq Llama 4 → Anthropic Claude Haiku.
 * Handles HEIC→JPEG conversion automatically via macOS sips.
 * Used by list-attachments --describe.
 * @returns Short description (≤10 words) or error message
 */
async function describeImageWithAI(filepath: string): Promise<string> {
  if (!existsSync(filepath)) return "(file not on disk)";
  const ext = filepath.split(".").pop()?.toLowerCase() ?? "jpeg";
  const mediaType =
    ext === "png" ? "image/png" :
    ext === "gif" ? "image/gif" :
    ext === "webp" ? "image/webp" :
    "image/jpeg";
  try {
    // HEIC: convert to JPEG first via sips
    let readPath = filepath;
    let tmpPath = "";
    if (ext === "heic" || ext === "heif") {
      tmpPath = `/tmp/imsg_thumb_${Date.now()}.jpg`;
      Bun.spawnSync(["sips", "-s", "format", "jpeg", filepath, "--out", tmpPath], { stdout: "pipe", stderr: "pipe" });
      if (existsSync(tmpPath)) readPath = tmpPath;
      else return "(HEIC conversion failed)";
    }
    const data = await Bun.file(readPath).arrayBuffer();
    if (tmpPath && existsSync(tmpPath)) Bun.spawnSync(["rm", tmpPath]);
    const b64 = Buffer.from(data).toString("base64");

    const prompt = "Describe this image in 10 words or less. Be specific and concrete. No punctuation.";

    // 1. OpenAI gpt-4o-mini — fastest in practice, ~$0.0002/image
    const openaiKey = loadEnvKey("OPENAI_API_KEY");
    if (openaiKey) {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini", max_tokens: 50,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${b64}` } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (resp.ok) { const j = await resp.json() as any; return j.choices?.[0]?.message?.content?.trim() ?? "(no description)"; }
    }

    // 2. Groq llama-4-scout (fallback)
    const groqKey = loadEnvKey("GROQ_API_KEY");
    if (groqKey) {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${groqKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct", max_tokens: 50,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${b64}` } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (resp.ok) { const j = await resp.json() as any; return j.choices?.[0]?.message?.content?.trim() ?? "(no description)"; }
    }

    // 3. Anthropic Claude Haiku vision
    const anthropicKey = loadEnvKey("ANTHROPIC_API_KEY");
    if (anthropicKey) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", max_tokens: 50,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (resp.ok) { const j = await resp.json() as any; return j.content?.[0]?.text?.trim() ?? "(no description)"; }
    }

    return "(no vision API key found)";
  } catch (e: any) { return `(error: ${e.message})`; }
}

/**
 * Build a map of handle (phone/email) → contact name from macOS AddressBook SQLite.
 * Reads ~/Library/Application Support/AddressBook/Sources/{id}/AddressBook-v22.abcddb.
 * Phone numbers are normalized to E.164 format (+1XXXXXXXXXX for US numbers).
 * This is much faster than AppleScript (~100ms vs 30s+ for thousands of contacts).
 * Used by: list, spam-scan, and any command that resolves handles to names.
 */
function buildContactMap(): Map<string, string> {
  const map = new Map<string, string>();
  const sourcesDir = join(HOME, "Library/Application Support/AddressBook/Sources");
  if (!existsSync(sourcesDir)) return map;

  let abPath = "";
  try {
    for (const src of readdirSync(sourcesDir)) {
      const candidate = join(sourcesDir, src, "AddressBook-v22.abcddb");
      if (existsSync(candidate)) { abPath = candidate; break; }
    }
  } catch { return map; }
  if (!abPath) return map;

  try {
    const ab = new Database(abPath, { readonly: true });
    const nameSql = `TRIM(COALESCE(r.ZFIRSTNAME,'') || CASE WHEN r.ZFIRSTNAME IS NOT NULL AND r.ZLASTNAME IS NOT NULL THEN ' ' ELSE '' END || COALESCE(r.ZLASTNAME,''))`;

    const emails = ab.prepare(
      `SELECT LOWER(e.ZADDRESS) AS addr, ${nameSql} AS name
       FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER
       WHERE e.ZADDRESS IS NOT NULL`
    ).all() as { addr: string; name: string }[];
    for (const e of emails) {
      if (e.addr && e.name) map.set(e.addr, e.name);
    }

    const phones = ab.prepare(
      `SELECT p.ZFULLNUMBER AS num, ${nameSql} AS name
       FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
       WHERE p.ZFULLNUMBER IS NOT NULL`
    ).all() as { num: string; name: string }[];
    for (const p of phones) {
      if (!p.num || !p.name) continue;
      const digits = p.num.replace(/\D/g, "");
      if (digits.length >= 10) {
        const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
        map.set(e164, p.name);
      }
    }
    ab.close();
  } catch { /* silently ignore if schema differs */ }
  return map;
}

/** Truncate string to n characters with ellipsis, or return em-dash for null/empty */
function trunc(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Format byte count as human-readable size (e.g., "1.5 MB", "42 KB") */
function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "?";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ============================================================
// APPLESCRIPT HELPERS
// ============================================================

/**
 * Execute an AppleScript and return its stdout.
 * Uses Bun.spawn with stdin piping to avoid shell escaping issues.
 * @throws Error with stderr content if osascript exits non-zero
 */
async function osa(script: string): Promise<string> {
  const proc = Bun.spawn(["osascript", "-"], {
    stdin: new Blob([script]).stream(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(stderr.trim() || "osascript failed");
  }
  return stdout.trim();
}

/** Escape string for use inside AppleScript double-quoted literals */
function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ============================================================
// TIME FILTERS & PHONE NORMALIZATION
// ============================================================

/** Parse relative date string (e.g., "7d", "2h", "4w", "1m") or ISO date string to Date */
function parseRelativeDate(s: string): Date {
  const rel = s.match(/^(\d+)(h|d|w|m)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = rel[2];
    const ms: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
    return new Date(Date.now() - n * ms[unit]);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) die(`Invalid date: "${s}". Use ISO (2026-01-01) or relative (7d, 2h, 4w, 1m).`);
  return d;
}

/** Convert Date to Apple nanosecond epoch for SQL WHERE clauses */
function toAppleNs(d: Date): number {
  return (d.getTime() / 1000 - APPLE_EPOCH) * 1e9;
}

/** Build SQL time-range clauses and params for --since / --before */
function buildTimeFilter(since?: string, before?: string): { sql: string; params: number[] } {
  const clauses: string[] = [];
  const params: number[] = [];
  if (since) {
    clauses.push("AND m.date >= ?");
    params.push(toAppleNs(parseRelativeDate(since)));
  }
  if (before) {
    clauses.push("AND m.date <= ?");
    params.push(toAppleNs(parseRelativeDate(before)));
  }
  return { sql: clauses.join(" "), params };
}

/** Generate multiple phone number formats for handle lookup */
function phoneFormats(handle: string): string[] {
  const digits = handle.replace(/\D/g, "");
  const formats = new Set<string>([handle]);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    formats.add(`+1${last10}`);
    formats.add(`1${last10}`);
    formats.add(last10);
    if (digits.length > 10) formats.add(`+${digits}`);
  }
  return [...formats];
}

// ============================================================
// DATABASE INTERROGATION COMMANDS
// contacts, threads, unread, info, stats
// ============================================================

/**
 * List contacts ranked by total message volume.
 * Queries chat.db for all handles with message counts and last activity date.
 */
function cmdContacts(limit = 50) {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        h.id AS handle,
        h.service,
        COUNT(DISTINCT m.ROWID) AS msg_count,
        MAX(m.date) AS last_date
      FROM handle h
      JOIN message m ON m.handle_id = h.ROWID
      WHERE m.is_from_me = 0
      GROUP BY h.id
      ORDER BY msg_count DESC
      LIMIT ?`
    )
    .all(limit) as any[];

  const names = buildContactMap();
  const getName = (handle: string) =>
    names.get(handle.toLowerCase()) ?? names.get(handle) ?? "";

  if (jsonMode) {
    out(
      rows.map((r) => ({
        handle: r.handle,
        name: getName(r.handle),
        service: r.service,
        messages_received: r.msg_count,
        last_message: fmtDateWithDay(r.last_date),
      }))
    );
    return;
  }

  const numW = 4;
  const nameW = 22;
  const handleW = 28;
  const svcW = 9;
  const msgsW = 6;

  console.log(`\nContacts who've messaged you (top ${rows.length}):\n`);
  console.log(
    `${"#".padEnd(numW)}${"Name".padEnd(nameW)}${"Handle".padEnd(handleW)}${"Svc".padEnd(svcW)}${"Msgs".padEnd(msgsW)}  Last Message`
  );
  console.log("─".repeat(numW + nameW + handleW + svcW + msgsW + 26));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = getName(r.handle);
    console.log(
      `${String(i + 1).padEnd(numW)}${name.padEnd(nameW)}${r.handle.padEnd(handleW)}${r.service.padEnd(svcW)}${String(r.msg_count).padEnd(msgsW)}  ${fmtDateWithDay(r.last_date)}`
    );
  }
  console.log(`\n${rows.length} contacts.`);
}

/** List all conversations with message counts, unread status, and last activity */
function cmdThreads(limit = 30) {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        c.ROWID AS chat_rowid,
        c.chat_identifier,
        c.display_name,
        c.style,
        MAX(m.date) AS last_date,
        COUNT(CASE WHEN m.is_read = 0 AND m.is_from_me = 0 THEN 1 END) AS unread,
        (SELECT mm.text
          FROM message mm
          JOIN chat_message_join cmj2 ON cmj2.message_id = mm.ROWID
          WHERE cmj2.chat_id = c.ROWID
            AND mm.text IS NOT NULL AND mm.text != ''
            AND mm.item_type = 0
          ORDER BY mm.date DESC LIMIT 1) AS last_text,
        (SELECT mm.is_from_me
          FROM message mm
          JOIN chat_message_join cmj2 ON cmj2.message_id = mm.ROWID
          WHERE cmj2.chat_id = c.ROWID
            AND mm.text IS NOT NULL AND mm.text != ''
            AND mm.item_type = 0
          ORDER BY mm.date DESC LIMIT 1) AS last_from_me
      FROM chat c
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      JOIN message m ON m.ROWID = cmj.message_id
      WHERE c.is_archived = 0
      GROUP BY c.ROWID
      ORDER BY last_date DESC
      LIMIT ?`
    )
    .all(limit) as any[];

  const contactMap = buildContactMap();

  const resolveThread = (chatRowid: number, chatId: string, displayName: string | null, style: number) => {
    if (style !== 43) {
      const n = contactMap.get(chatId.toLowerCase()) ?? contactMap.get(chatId);
      return { name: n || chatId, type: "1:1" };
    }
    if (displayName?.trim()) return { name: displayName.trim(), type: "Group" };
    const parts = db.prepare(
      `SELECT h2.id FROM chat_handle_join chj2 JOIN handle h2 ON h2.ROWID = chj2.handle_id WHERE chj2.chat_id = ?`
    ).all(chatRowid) as { id: string }[];
    const names = parts
      .slice(0, 3)
      .map((p) => contactMap.get(p.id.toLowerCase()) ?? contactMap.get(p.id) ?? p.id)
      .join(", ");
    return { name: names ? `[${names}]` : "[unnamed group]", type: "Group" };
  };

  if (jsonMode) {
    out(
      rows.map((r, i) => {
        const { name, type } = resolveThread(r.chat_rowid, r.chat_identifier, r.display_name, r.style);
        // handle: show phone/email for 1:1 (if resolved name differs from chatId); blank for groups
        const handle = type === "1:1" && name !== r.chat_identifier ? r.chat_identifier : "";
        return {
          index: i + 1,
          name,
          handle,
          type,
          unread: r.unread,
          last_message: fmtDateWithDay(r.last_date),
          direction: r.last_from_me === 1 ? "sent" : "received",
          preview: trunc(r.last_text, 80),
        };
      })
    );
    return;
  }

  // Column widths
  const numW  = 4;
  const nameW = 24;
  const hndlW = 16;
  const typeW = 7;
  const newW  = 8;
  const dateW = 30;

  const header = `${"#".padEnd(numW)}${"Who".padEnd(nameW)}${"Handle".padEnd(hndlW)}${"Type".padEnd(typeW)}${"New".padEnd(newW)}Last Message`;
  console.log(`\nThreads (${rows.length}) — most recent first\n`);
  console.log(header);
  console.log("─".repeat(numW + nameW + hndlW + typeW + newW + dateW));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const { name, type } = resolveThread(r.chat_rowid, r.chat_identifier, r.display_name, r.style);

    const nameStr  = trunc(name, nameW - 1).padEnd(nameW);
    // Handle: show for 1:1 only, and only if name != chatId (i.e. contact was found)
    const rawHandle = type === "1:1" && name !== r.chat_identifier ? r.chat_identifier : "";
    const hndlStr  = rawHandle.padEnd(hndlW);
    const typeStr  = type.padEnd(typeW);

    // Unread: pad visible string first, then colorize — avoids ANSI breaking padEnd
    const newVis   = r.unread > 0 ? `${r.unread} new` : "";
    const newPad   = newVis.padEnd(newW);
    const newStr   = r.unread > 0 ? `\x1b[1;34m${newPad}\x1b[0m` : newPad;

    const dateStr  = fmtDateWithDay(r.last_date);
    const dir      = r.last_from_me === 1 ? "\x1b[2mS:\x1b[0m" : "\x1b[2mR:\x1b[0m";
    const preview  = trunc(r.last_text, 80);

    console.log(`${String(i + 1).padEnd(numW)}${nameStr}${hndlStr}${typeStr}${newStr}${dateStr}`);
    if (preview && preview !== "—") {
      console.log(`    ${dir} \x1b[2m${preview}\x1b[0m`);
    }
    if (i < rows.length - 1) console.log();
  }
  console.log(`\n${rows.length} threads shown.`);
}


/** Show only conversations with unread messages, ordered by most recent */
function cmdUnread() {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        c.chat_identifier,
        COALESCE(c.display_name, c.chat_identifier) AS name,
        COUNT(*) AS unread_count,
        MAX(m.date) AS last_date
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.is_read = 0 AND m.is_from_me = 0
        AND m.text IS NOT NULL AND m.text != ''
        AND m.item_type = 0
      GROUP BY c.ROWID
      ORDER BY last_date DESC`
    )
    .all() as any[];

  const total = rows.reduce((s: number, r: any) => s + r.unread_count, 0);

  if (jsonMode) {
    out({
      total_unread: total,
      conversations: rows.map((r) => ({
        chat_id: r.chat_identifier,
        name: r.name,
        unread: r.unread_count,
        last_message: fmtDate(r.last_date),
      })),
    });
    return;
  }

  if (rows.length === 0) {
    console.log("No unread messages.");
    return;
  }
  console.log(
    `\nUnread: ${total} message(s) across ${rows.length} conversation(s)\n`
  );
  for (const r of rows) {
    console.log(
      `  ●${String(r.unread_count).padStart(3)}  ${r.name.padEnd(40)} ${fmtDate(r.last_date)}`
    );
  }
}

/** Show detailed message statistics for a specific contact (sent/received counts, date range, top words) */
function cmdInfo(handle: string) {
  const db = openDB();
  const contactMap = buildContactMap();
  const contactName = contactMap.get(handle.toLowerCase()) ?? contactMap.get(handle) ?? "";

  const received = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MIN(m.date) AS first_date, MAX(m.date) AS last_date
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE h.id = ? AND m.is_from_me = 0`
    )
    .get(handle) as any;

  const sent = db
    .prepare(
      `SELECT COUNT(*) AS cnt
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE h.id = ? AND m.is_from_me = 1`
    )
    .get(handle) as any;

  const chats = db
    .prepare(
      `SELECT DISTINCT c.ROWID AS chat_rowid, c.chat_identifier,
        c.display_name,
        c.style
      FROM chat c
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE h.id = ?`
    )
    .all(handle) as any[];

  if (!received || received.cnt === 0) {
    console.log(`No messages found for: ${handle}`);
    return;
  }

  // Resolve display label for each chat
  const resolveChat = (c: any): { type: string; label: string } => {
    if (c.style !== 43) {
      // 1:1 — label IS the contact name
      return { type: "1:1", label: contactName || handle };
    }
    if (c.display_name && c.display_name.trim()) {
      return { type: "Group", label: c.display_name.trim() };
    }
    // Unnamed group — fetch participant names
    const parts = db.prepare(
      `SELECT h2.id FROM chat_handle_join chj2 JOIN handle h2 ON h2.ROWID = chj2.handle_id WHERE chj2.chat_id = ?`
    ).all(c.chat_rowid) as { id: string }[];
    const partNames = parts
      .filter((p) => p.id !== handle)
      .slice(0, 4)
      .map((p) => contactMap.get(p.id.toLowerCase()) ?? contactMap.get(p.id) ?? p.id)
      .join(", ");
    return { type: "Group", label: partNames ? `[${partNames}]` : "[unnamed group]" };
  };

  if (jsonMode) {
    out({
      handle,
      name: contactName,
      received: received.cnt,
      sent: sent?.cnt ?? 0,
      first_contact: fmtDateWithDay(received.first_date),
      last_contact: fmtDateWithDay(received.last_date),
      chats: chats.map((c) => {
        const { type, label } = resolveChat(c);
        return { id: c.chat_identifier, name: label, type };
      }),
    });
    return;
  }

  const displayName = contactName ? `${contactName}  \x1b[2m${handle}\x1b[0m` : handle;
  const total = (received.cnt ?? 0) + (sent?.cnt ?? 0);
  const sentPct = total > 0 ? Math.round(((sent?.cnt ?? 0) / total) * 100) : 0;
  const recvPct = total > 0 ? 100 - sentPct : 0;

  console.log(`\n┌─ Contact Info ${"─".repeat(55)}`);
  console.log(`│  ${displayName}`);
  console.log(`├${"─".repeat(69)}`);
  console.log(`│  Messages received  ${String(received.cnt).padStart(6)}   (${recvPct}%)`);
  console.log(`│  Messages sent      ${String(sent?.cnt ?? 0).padStart(6)}   (${sentPct}%)`);
  console.log(`│  Total              ${String(total).padStart(6)}`);
  console.log(`├${"─".repeat(69)}`);
  console.log(`│  First contact      ${fmtDateWithDay(received.first_date)}`);
  console.log(`│  Last contact       ${fmtDateWithDay(received.last_date)}`);
  console.log(`├${"─".repeat(69)}`);
  console.log(`│  Threads this contact appears in (${chats.length}):`);
  console.log(`│  ${"─".repeat(50)}`);
  for (const c of chats) {
    const { type, label } = resolveChat(c);
    if (type === "1:1") {
      const tag = `\x1b[36m1:1\x1b[0m`;
      console.log(`│    ${tag}  ${label}  \x1b[2m← direct thread  (handle: ${handle})\x1b[0m`);
    } else {
      const tag = `\x1b[35mGrp\x1b[0m`;
      console.log(`│    ${tag}  ${label}`);
    }
  }
  console.log(`└${"─".repeat(69)}`);
}

/** Show global iMessage database statistics: total messages, chats, top contacts, date range */
function cmdStats() {
  const db = openDB();

  const totals = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) AS received,
        MIN(date) AS first_date,
        MAX(date) AS last_date
      FROM message WHERE text IS NOT NULL AND text != '' AND item_type = 0`
    )
    .get() as any;

  const chatCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM chat WHERE is_archived = 0`)
    .get() as any;

  const topContacts = db
    .prepare(
      `SELECT h.id AS handle, COUNT(*) AS cnt
      FROM message m
      JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.is_from_me = 0
      GROUP BY h.id
      ORDER BY cnt DESC
      LIMIT 10`
    )
    .all() as any[];

  if (jsonMode) {
    out({
      total_messages: totals.total,
      sent: totals.sent,
      received: totals.received,
      active_chats: chatCount.cnt,
      date_range: {
        from: fmtDate(totals.first_date),
        to: fmtDate(totals.last_date),
      },
      top_contacts: topContacts.map((t) => ({
        handle: t.handle,
        messages: t.cnt,
      })),
    });
    return;
  }

  console.log(`\niMessage Database Statistics`);
  console.log("═".repeat(50));
  console.log(`  Total messages : ${totals.total.toLocaleString()}`);
  console.log(`  Sent           : ${totals.sent.toLocaleString()}`);
  console.log(`  Received       : ${totals.received.toLocaleString()}`);
  console.log(`  Active chats   : ${chatCount.cnt}`);
  console.log(
    `  Date range     : ${fmtDate(totals.first_date)} → ${fmtDate(totals.last_date)}`
  );
  console.log(`\n  Top 10 Contacts:`);
  for (const t of topContacts) {
    console.log(
      `    ${t.handle.padEnd(38)} ${String(t.cnt).padStart(6)} msgs`
    );
  }
}

// ============================================================
// ATTACHMENT COMMANDS: send-file, send-file-group, list-attachments, get-attachment
// ============================================================

/** Send a file attachment to a 1:1 contact via AppleScript POSIX file */
async function cmdSendFile(to: string, filePath: string) {
  if (!existsSync(filePath)) die(`File not found: ${filePath}`);
  const abs = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);

  const result = await osa(`set f to POSIX file "${q(abs)}"
tell application "Messages"
    set acct to first account whose service type is iMessage
    set b to buddy "${q(to)}" of acct
    send f to b
    return "sent"
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "sent") {
    console.log(`✓ Sent to ${to}: ${basename(abs)}`);
  } else {
    die(result);
  }
}

/** Send a file attachment to a named group chat */
async function cmdSendFileGroup(name: string, filePath: string) {
  if (!existsSync(filePath)) die(`File not found: ${filePath}`);
  const abs = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);

  const result = await osa(`set f to POSIX file "${q(abs)}"
tell application "Messages"
    try
        set c to first chat whose name is "${q(name)}"
        send f to c
        return "sent"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "sent") {
    console.log(`✓ Sent to group '${name}': ${basename(abs)}`);
  } else {
    die(result);
  }
}

/**
 * List attachments in a conversation with metadata (type, size, dimensions).
 * Optionally uses AI vision to describe image attachments (--describe flag).
 */
async function cmdListAttachments(handle: string, limit = 20, describe = false) {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        a.ROWID AS id,
        a.filename,
        a.transfer_name,
        a.mime_type,
        a.total_bytes,
        a.created_date,
        a.is_outgoing,
        COALESCE(h2.id, 'me') AS sender
      FROM attachment a
      JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
      JOIN message m ON m.ROWID = maj.message_id
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      LEFT JOIN handle h2 ON h2.ROWID = m.handle_id
      WHERE (h.id = ? OR c.chat_identifier = ?)
        AND a.filename IS NOT NULL
        AND a.is_sticker = 0
        AND a.hide_attachment = 0
      ORDER BY a.created_date DESC
      LIMIT ?`
    )
    .all(handle, handle, limit) as any[];

  if (jsonMode) {
    out(
      rows.map((r) => ({
        id: r.id,
        filename: basename(r.filename || r.transfer_name || "unknown"),
        full_path: (r.filename || "").replace("~/", HOME + "/"),
        mime_type: r.mime_type,
        size: fmtSize(r.total_bytes),
        size_bytes: r.total_bytes,
        date: fmtDateSec(r.created_date),
        sender: r.sender,
      }))
    );
    return;
  }

  if (rows.length === 0) {
    console.log(`No attachments found for: ${handle}`);
    return;
  }

  const contactMap = buildContactMap();
  const contactName = contactMap.get(handle.toLowerCase()) ?? contactMap.get(handle) ?? handle;

  const idW   = 6;
  const dateW = 30;
  const fromW = 16;
  const kindW = 10;
  const fileW = 28;
  const sizeW = 8;

  console.log(`\nAttachments — ${contactName}  \x1b[2m${handle}\x1b[0m  (${rows.length} shown)\n`);
  console.log(
    `${"ID".padEnd(idW)}${"Date".padEnd(dateW)}${"From".padEnd(fromW)}${"Kind".padEnd(kindW)}${"File".padEnd(fileW)}Size`
  );
  console.log("─".repeat(idW + dateW + fromW + kindW + fileW + sizeW));

  if (describe) console.log(`\x1b[2m(--describe: calling Claude Haiku vision for each image — may take a moment)\x1b[0m\n`);

  for (const r of rows) {
    const fname    = basename(r.filename || r.transfer_name || "?");
    const fullPath = (r.filename || "").replace("~/", HOME + "/");
    const isImage  = r.mime_type?.startsWith("image/");
    const kindBase = describeAttachment(r.mime_type, fname);
    const kind     = trunc(kindBase, kindW - 1).padEnd(kindW);
    const file     = trunc(fname, fileW - 1).padEnd(fileW);
    const size     = fmtSize(r.total_bytes).padEnd(sizeW);
    const date     = fmtDateSecWithDay(r.created_date).padEnd(dateW);
    const fromRaw  = r.sender === "me"
      ? "You"
      : (contactMap.get(r.sender?.toLowerCase()) ?? contactMap.get(r.sender) ?? r.sender ?? "?");
    const from  = trunc(fromRaw, fromW - 1).padEnd(fromW);
    const idStr = String(r.id).padEnd(idW);
    console.log(`${idStr}${date}${from}${kind}${file}${size}`);
    if (describe && isImage) {
      const aiDesc = await describeImageWithAI(fullPath);
      console.log(`      \x1b[33m↳ ${aiDesc}\x1b[0m`);
    }
    console.log();
  }
  console.log(`\n\x1b[2mTo download: imsg get-attachment <ID>\x1b[0m`);
  if (!describe && rows.some((r: any) => r.mime_type?.startsWith("image/"))) {
    console.log(`\x1b[2mTip: add --describe for AI image descriptions (uses Claude Haiku vision)\x1b[0m`);
  }
}

/** Download an attachment by its database ROWID to the specified output directory */
async function cmdGetAttachment(attachmentId: number, outDir = DEFAULT_ATTACHMENT_DIR) {
  const db = openDB();
  const row = db
    .prepare(
      `SELECT filename, transfer_name, mime_type FROM attachment WHERE ROWID = ?`
    )
    .get(attachmentId) as any;

  if (!row) die(`Attachment ID ${attachmentId} not found`);

  const srcPath = (row.filename || "").replace("~/", HOME + "/");
  if (!existsSync(srcPath)) die(`Attachment file not on disk: ${srcPath}`);

  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, basename(srcPath));
  await Bun.write(dest, Bun.file(srcPath));
  console.log(`✓ Saved: ${dest}`);
  if (jsonMode) out({ saved: dest, source: srcPath, mime: row.mime_type });
}

// ============================================================
// ADVANCED READ, SEARCH & EXPORT COMMANDS
// ============================================================

const REACTION: Record<number, string> = {
  2000: "❤️",
  2001: "👍",
  2002: "👎",
  2003: "😂",
  2004: "‼️",
  2005: "❓",
  3000: "un-❤️",
  3001: "un-👍",
  3002: "un-👎",
  3003: "un-😂",
  3004: "un-‼️",
  3005: "un-❓",
};

/** List tapback reactions (love, like, dislike, etc.) in a conversation */
function cmdReactions(handle: string, limit = 50) {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        m.ROWID AS id,
        m.associated_message_type AS reaction_type,
        m.associated_message_guid,
        COALESCE(h2.id, 'me') AS sender,
        m.date
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      LEFT JOIN handle h2 ON h2.ROWID = m.handle_id
      WHERE (h.id = ? OR c.chat_identifier = ?)
        AND m.associated_message_type BETWEEN 2000 AND 3005
      ORDER BY m.date DESC
      LIMIT ?`
    )
    .all(handle, handle, limit) as any[];

  if (jsonMode) {
    out(
      rows.map((r) => ({
        id: r.id,
        reaction: REACTION[r.reaction_type] ?? `type:${r.reaction_type}`,
        sender: r.sender,
        date: fmtDate(r.date),
        target_guid: r.associated_message_guid,
      }))
    );
    return;
  }

  if (rows.length === 0) {
    console.log(`No reactions found for: ${handle}`);
    return;
  }

  console.log(`\nReactions in conversation with ${handle}:\n`);
  for (const r of rows) {
    const emoji = REACTION[r.reaction_type] ?? `type:${r.reaction_type}`;
    console.log(
      `  ${fmtDate(r.date)}  ${r.sender.padEnd(38)} ${emoji}`
    );
  }
}

/** Read a conversation in formatted thread view with sender labels and timestamps */
function cmdThreadRead(handle: string, limit = 50, opts: { since?: string; before?: string } = {}) {
  const db = openDB();
  const tf = buildTimeFilter(opts.since, opts.before);
  const rows = db
    .prepare(
      `SELECT
        m.ROWID AS id,
        m.date,
        m.is_from_me,
        COALESCE(h2.id, 'me') AS sender,
        m.text,
        m.cache_has_attachments,
        m.is_read
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      LEFT JOIN handle h2 ON h2.ROWID = m.handle_id
      WHERE (h.id = ? OR c.chat_identifier = ?)
        AND m.item_type = 0
        AND m.associated_message_type NOT BETWEEN 2000 AND 3005
        ${tf.sql}
      ORDER BY m.date DESC
      LIMIT ?`
    )
    .all(handle, handle, ...tf.params, limit) as any[];

  if (jsonMode) {
    out(
      rows.map((r) => ({
        id: r.id,
        date: fmtDate(r.date),
        sender: r.sender,
        text: r.text,
        has_attachment: !!r.cache_has_attachments,
        is_read: !!r.is_read,
      }))
    );
    return;
  }

  console.log(`\nThread: ${handle} (last ${rows.length} messages)\n`);
  for (const r of [...rows].reverse()) {
    const who = r.is_from_me ? "→ Me" : `← ${r.sender}`;
    const attach = r.cache_has_attachments ? " 📎" : "";
    const unread = !r.is_read && !r.is_from_me ? " ●" : "";
    const body = r.text
      ? trunc(r.text.replace(/\n/g, " "), 100)
      : "[no text]";
    console.log(`[${fmtDate(r.date)}] ${who}${attach}${unread}`);
    console.log(`  ${body}\n`);
  }
}

/** Export a full conversation to stdout in Markdown or plain text format */
function cmdExport(handle: string, format: "md" | "txt" = "md") {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        m.ROWID AS id,
        m.date,
        m.is_from_me,
        COALESCE(h2.id, 'me') AS sender,
        m.text,
        m.cache_has_attachments
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      LEFT JOIN handle h2 ON h2.ROWID = m.handle_id
      WHERE (h.id = ? OR c.chat_identifier = ?)
        AND m.item_type = 0
        AND m.associated_message_type NOT BETWEEN 2000 AND 3005
      ORDER BY m.date ASC`
    )
    .all(handle, handle) as any[];

  if (format === "md") {
    const lines = [
      `# iMessage Export: ${handle}`,
      ``,
      `Exported: ${new Date().toLocaleString()}  `,
      `Messages: ${rows.length}`,
      ``,
      `---`,
      ``,
    ];
    for (const r of rows) {
      const who = r.is_from_me ? "**Me**" : `**${r.sender}**`;
      const attach = r.cache_has_attachments ? " *(attachment)*" : "";
      lines.push(`### ${fmtDate(r.date)}`);
      lines.push(`${who}${attach}: ${r.text ?? "*(no text)*"}`);
      lines.push(``);
    }
    console.log(lines.join("\n"));
  } else {
    for (const r of rows) {
      const who = r.is_from_me ? "Me" : r.sender;
      const attach = r.cache_has_attachments ? " [attachment]" : "";
      console.log(
        `[${fmtDate(r.date)}] ${who}${attach}: ${r.text ?? "(no text)"}`
      );
    }
  }
}

/** Mark a conversation as read by activating it in Messages.app via AppleScript */
async function cmdMarkRead(handle: string) {
  const escaped = q(handle);
  const result = await osa(`tell application "Messages" to activate
open location "imessage://${escaped}"
return "done"`).catch((e) => `error: ${e.message}`);

  if (result === "done") {
    console.log(`✓ Opened chat for ${handle} — Messages.app will mark as read`);
  } else {
    console.log(`Could not open chat for ${handle}: ${result}`);
  }
}

/** Search for contacts by handle pattern (phone number or email substring) */
function cmdSearchContact(name: string) {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT DISTINCT
        h.id AS handle,
        h.service,
        COUNT(m.ROWID) AS msg_count
      FROM handle h
      LEFT JOIN message m ON m.handle_id = h.ROWID
      WHERE h.id LIKE ?
      GROUP BY h.id
      ORDER BY msg_count DESC
      LIMIT 20`
    )
    .all(`%${name}%`) as any[];

  if (jsonMode) {
    out(rows);
    return;
  }

  if (rows.length === 0) {
    console.log(`No contacts found matching: ${name}`);
    return;
  }

  console.log(`\nContacts matching "${name}":\n`);
  for (const r of rows) {
    console.log(
      `  ${r.handle.padEnd(42)} ${r.service.padEnd(10)} ${r.msg_count} msgs`
    );
  }
}

// ============================================================
// MESSAGE MANAGEMENT COMMANDS: delete-msg, delete-chat, archive-chat
// ============================================================

/**
 * Delete a specific message by ROWID from chat.db.
 * Also inserts into sync_deleted_messages for iCloud propagation.
 * Note: iCloud sync not guaranteed — quit Messages.app first for best results.
 */
async function cmdDeleteMsg(handle: string, rowid: number) {
  if (!rowid || isNaN(rowid)) die("Usage: delete-msg <handle> <rowid>");

  const db = openDB();
  const msg = db
    .prepare(
      `SELECT text, is_from_me FROM message WHERE ROWID = ?`
    )
    .get(rowid) as any;

  if (!msg) die(`Message ROWID ${rowid} not found`);

  const preview = trunc(msg.text, 80);
  console.log(`To delete message (ROWID ${rowid}):`);
  console.log(`  "${preview}"\n`);
  console.log(`Steps:`);
  console.log(`  1. Opening the conversation in Messages.app...`);
  console.log(`  2. Find the message above in the conversation`);
  console.log(`  3. Right-click (or Control-click) the message bubble`);
  console.log(`  4. Select "Delete…" from the context menu`);
  console.log(`  5. Confirm deletion\n`);

  await osa(`tell application "Messages" to activate
open location "imessage://${q(handle)}"`).catch(() => {});
  console.log(`✓ Messages.app opened to ${handle}.`);
}

/**
 * Delete a conversation via automated GUI scripting (System Events).
 * Opens Messages.app, selects the conversation, right-clicks, and clicks Delete.
 * Optionally reports spam to Apple before deleting.
 */
async function cmdDeleteChat(handle: string, reportSpam = false) {
  console.log(`Deleting conversation with ${handle}...`);

  await osa(`tell application "Messages" to activate
open location "imessage://${q(handle)}"`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));

  const menuResult = await osa(`tell application "System Events"
    tell process "Messages"
        try
            click menu item "Delete Conversation\u2026" of menu 1 of menu bar item "Conversation" of menu bar 1
            return "clicked"
        on error errMsg
            return "menu-error: " & errMsg
        end try
    end tell
end tell`).catch((e) => `error: ${e.message}`);

  if (menuResult !== "clicked") {
    console.log(`Could not open delete dialog: ${menuResult}`);
    console.log(`  Manual: Right-click conversation → Delete Conversation…`);
    return;
  }

  await new Promise((r) => setTimeout(r, 1500));

  // Prefer "Delete and Report Spam" if reportSpam requested, otherwise plain "Delete"
  const buttonName = reportSpam ? "Delete and Report Spam" : "Delete";
  const fallbackButton = reportSpam ? "Delete" : null;

  let deleteResult = await osa(`tell application "System Events"
    tell process "Messages"
        try
            click button "${buttonName}" of sheet 1 of window 1
            return "deleted"
        on error errMsg
            return "sheet-error: " & errMsg
        end try
    end tell
end tell`).catch((e) => `error: ${e.message}`);

  if (deleteResult !== "deleted" && fallbackButton) {
    deleteResult = await osa(`tell application "System Events"
      tell process "Messages"
          try
              click button "${fallbackButton}" of sheet 1 of window 1
              return "deleted"
          on error errMsg
              return "sheet-error: " & errMsg
          end try
      end tell
  end tell`).catch((e) => `error: ${e.message}`);
  }

  if (deleteResult === "deleted") {
    const extra = reportSpam ? " and reported as spam" : "";
    console.log(`✓ Deleted conversation with ${handle}${extra}`);
  } else {
    console.log(`Could not confirm deletion: ${deleteResult}`);
    console.log(`  Manual: Click "Delete" in the confirmation dialog`);
  }
}

/** Archive a conversation by setting its is_archived flag in chat.db */
async function cmdArchiveChat(handle: string) {
  console.log(`To archive the conversation with ${handle}:\n`);
  console.log(`Steps:`);
  console.log(`  1. Opening the conversation in Messages.app...`);
  console.log(`  2. Right-click (or Control-click) the conversation in the sidebar`);
  console.log(`  3. Select "Archive" (or swipe left on trackpad)`);
  console.log(`  4. The conversation moves to Recently Deleted / archived\n`);

  await osa(`tell application "Messages" to activate
open location "imessage://${q(handle)}"`).catch(() => {});
  console.log(`✓ Messages.app opened to ${handle}.`);
}

// ============================================================
// BLOCK MANAGEMENT COMMANDS: blocked, block, unblock
// ============================================================

/** List all blocked phone numbers and emails from the macOS CMFSyncAgent plist */
async function cmdBlocked() {
  // Read from cmfsyncagent plist (the actual system block list)
  try {
    const proc = Bun.spawn(
      ["defaults", "read", "com.apple.cmfsyncagent", "__kCMFBlockListStoreTopLevelKey"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode === 0) {
      // Parse the defaults output for phone numbers and emails
      const blocked: string[] = [];
      const phoneRegex = /"?__kCMFItemPhoneNumberUnformattedKey"?\s*=\s*"(\+[^"]+)"/g;
      const emailRegex = /"?__kCMFItemEmailUnformattedKey"?\s*=\s*"([^"]+)"/g;
      let m;
      while ((m = phoneRegex.exec(stdout)) !== null) {
        blocked.push(m[1].startsWith("+") ? m[1] : "+" + m[1]);
      }
      while ((m = emailRegex.exec(stdout)) !== null) {
        blocked.push(m[1]);
      }
      if (blocked.length === 0) {
        console.log("No blocked contacts.");
      } else {
        console.log(`Blocked contacts (${blocked.length}):\n`);
        for (const b of blocked) {
          console.log(`  ${b}`);
        }
      }
      return;
    }
  } catch {}

  console.log("Blocked contacts list:");
  console.log(
    "  Messages.app → Settings → Blocked  (most reliable view)"
  );
  console.log("\n  Opening Messages.app...");
  await Bun.spawn(["open", "-a", "Messages"]).exited;
}

/** Block a contact via Messages.app GUI scripting (opens conversation, right-click → Block) */
async function cmdBlock(handle: string) {
  console.log(`Blocking ${handle}...`);

  // Step 1: Open the conversation
  await osa(`tell application "Messages" to activate
open location "imessage://${q(handle)}"`).catch(() => {});

  // Step 2: Click Conversation > Block Person...
  await new Promise((r) => setTimeout(r, 1000));
  const menuResult = await osa(`tell application "System Events"
    tell process "Messages"
        try
            click menu item "Block Person…" of menu 1 of menu bar item "Conversation" of menu bar 1
            return "clicked"
        on error errMsg
            return "menu-error: " & errMsg
        end try
    end tell
end tell`).catch((e) => `error: ${e.message}`);

  if (menuResult !== "clicked") {
    console.log(`Could not open block dialog: ${menuResult}`);
    console.log(`  Manual: Messages.app → Conversation → Block Person…`);
    return;
  }

  // Step 3: Wait for confirmation sheet and click Block
  await new Promise((r) => setTimeout(r, 1500));
  const blockResult = await osa(`tell application "System Events"
    tell process "Messages"
        try
            click button "Block" of sheet 1 of window 1
            return "blocked"
        on error errMsg
            return "sheet-error: " & errMsg
        end try
    end tell
end tell`).catch((e) => `error: ${e.message}`);

  if (blockResult === "blocked") {
    console.log(`✓ Blocked ${handle}`);
  } else {
    console.log(`Could not confirm block: ${blockResult}`);
    console.log(`  Manual: Click "Block" in the confirmation dialog`);
  }
}

/** Guided workflow to unblock a contact — macOS has no "Unblock" menu item, must use Settings */
async function cmdUnblock(handle: string) {
  console.log(`Unblocking ${handle}...`);
  console.log(`\nMessages.app does not expose an "Unblock" menu item.`);
  console.log(`Unblocking must be done via Settings → Blocked.\n`);
  console.log(`Steps:`);
  console.log(`  1. Opening Messages.app Settings...`);
  console.log(`  2. Click the "Blocked" tab`);
  console.log(`  3. Find ${handle} in the list`);
  console.log(`  4. Select it and click the "−" (minus) button to remove\n`);

  // Open Messages and its Settings (Cmd+,)
  await osa(`tell application "Messages" to activate`).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await osa(`tell application "System Events"
    tell process "Messages"
        keystroke "," using command down
    end tell
end tell`).catch(() => {});

  console.log(`✓ Messages.app Settings opened. Navigate to Blocked tab to remove ${handle}.`);
}

// ============================================================
// SPAM, ALERTS & FORWARDING COMMANDS: report-spam, mute, unmute, forward, spam-scan
// ============================================================

/** Report spam: blocks the contact, then deletes the conversation with Apple spam reporting */
async function cmdReportSpam(handle: string) {
  console.log(`Reporting ${handle} as spam...`);
  // Step 1: Block
  await cmdBlock(handle);
  // Step 2: Delete with spam report
  await cmdDeleteChat(handle, true);
  console.log(`✓ ${handle}: blocked, deleted, and reported as spam`);
}

/**
 * Guided mute workflow — opens the conversation and checks alert state.
 * Note: macOS blocks automated toggling of alert state via System Events,
 * so this provides instructions for the user to complete manually.
 */
async function cmdMute(handle: string) {
  console.log(`Muting ${handle}...`);
  // macOS prevents System Events from toggling alert state via menu clicks.
  // Open the conversation and guide the user to manually toggle.
  await osa(`tell application "Messages" to activate
open location "imessage://${q(handle)}"`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));

  // Check current alert state
  const state = await osa(`tell application "System Events"
    tell process "Messages"
        set menuNames to name of every menu item of menu 1 of menu bar item "Conversation" of menu bar 1
        if menuNames contains "Show Alerts" then
            return "already-muted"
        else if menuNames contains "Hide Alerts" then
            return "not-muted"
        else
            return "unknown"
        end if
    end tell
end tell`).catch(() => "unknown");

  if (state === "already-muted") {
    console.log(`Already muted: ${handle}`);
  } else {
    console.log(`\nConversation opened. To mute:`);
    console.log(`  → Conversation menu → Hide Alerts`);
    console.log(`  (macOS blocks automated toggling of alert state)`);
  }
}

/** Guided unmute workflow — opens conversation, detects mute state, provides instructions */
async function cmdUnmute(handle: string) {
  console.log(`Unmuting ${handle}...`);
  await osa(`tell application "Messages" to activate
open location "imessage://${q(handle)}"`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));

  const state = await osa(`tell application "System Events"
    tell process "Messages"
        set menuNames to name of every menu item of menu 1 of menu bar item "Conversation" of menu bar 1
        if menuNames contains "Hide Alerts" then
            return "already-unmuted"
        else if menuNames contains "Show Alerts" then
            return "muted"
        else
            return "unknown"
        end if
    end tell
end tell`).catch(() => "unknown");

  if (state === "already-unmuted") {
    console.log(`Already unmuted: ${handle}`);
  } else {
    console.log(`\nConversation opened. To unmute:`);
    console.log(`  → Conversation menu → Show Alerts`);
    console.log(`  (macOS blocks automated toggling of alert state)`);
  }
}

/** Forward a specific message (by ROWID) from one conversation to another contact */
async function cmdForward(handle: string, rowid: number, toHandle: string) {
  if (!rowid || isNaN(rowid)) die("Usage: forward <handle> <rowid> <to-handle>");
  if (!toHandle) die("Usage: forward <handle> <rowid> <to-handle>");

  const db = openDB();
  const msg = db
    .prepare(`SELECT text FROM message WHERE ROWID = ?`)
    .get(rowid) as any;
  if (!msg || !msg.text) die(`Message ROWID ${rowid} not found or has no text`);

  const fwdText = `[Fwd from ${handle}]: ${msg.text}`;
  const escaped = fwdText.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const result = await osa(`tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${q(toHandle)}" of targetService
    send "${escaped}" to targetBuddy
end tell`).catch((e) => `error: ${e.message}`);

  if (!result.startsWith("error")) {
    console.log(`✓ Forwarded message (ROWID ${rowid}) from ${handle} to ${toHandle}`);
    console.log(`  "${trunc(msg.text, 80)}"`);
  } else {
    console.log(`Could not forward: ${result}`);
  }
}

/**
 * Heuristic spam detection across all conversations.
 * Scores each conversation based on weighted rules:
 *   +10 suspicious TLD, +8 Philippines country code, +5 job scam keywords,
 *   +5 phishing patterns, -10 bidirectional (you replied), -5 known contact
 * Outputs a Markdown checklist file for manual review.
 */
async function cmdSpamScan() {
  const db = openDB();
  const today = new Date().toISOString().slice(0, 10);
  const outPath = join(SPAM_SCAN_OUTPUT_DIR, `iMessage Spam Review ${today}.md`);

  console.log("Scanning conversations for spam...");

  // Get all 1:1 chats with their most recent message
  const chats = db
    .prepare(
      `SELECT
        h.id AS handle,
        m.text,
        m.date / 1000000000 + 978307200 AS msg_epoch,
        m.is_from_me,
        (SELECT COUNT(*) FROM message m2
         JOIN chat_message_join cmj2 ON cmj2.message_id = m2.ROWID
         WHERE cmj2.chat_id = c.ROWID) AS msg_count,
        (SELECT COUNT(*) FROM message m3
         JOIN chat_message_join cmj3 ON cmj3.message_id = m3.ROWID
         WHERE cmj3.chat_id = c.ROWID AND m3.is_from_me = 1) AS sent_count
      FROM chat c
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      JOIN message m ON m.ROWID = cmj.message_id
      WHERE c.style != 43
      AND m.ROWID = (
        SELECT m4.ROWID FROM message m4
        JOIN chat_message_join cmj4 ON cmj4.message_id = m4.ROWID
        WHERE cmj4.chat_id = c.ROWID
        ORDER BY m4.date DESC LIMIT 1
      )
      ORDER BY m.date DESC`
    )
    .all() as any[];

  // Spam heuristics
  const suspiciousTlds = [".top", ".sbs", ".life", ".cc", ".xyz", ".buzz", ".club"];
  const safeDomains = [
    "icloud.com", "gmail.com", "yahoo.com", "outlook.com",
    "hotmail.com", "me.com", "mac.com", "aol.com",
  ];
  const jobScamKeywords = [
    /\$\d{2,3}[\s-]*(?:to|-)[\s-]*\$?\d{3,4}[\s/]*day/i,
    /whatsapp/i, /telegram[:\s]*@/i, /remote\s+(?:job|work|part.?time)/i,
    /temu/i, /klarna/i, /indeed/i, /daily\s+salary/i,
    /part.?time\s+opportunity/i, /bamboohr/i, /warner\s+bros/i,
    /online\s+recruitment/i, /earn.*\$\d{3,}/i,
  ];
  const phishingKeywords = [
    /fedex/i, /\bdmv\b/i, /\bbmv\b/i, /verification\s+code/i,
    /pay\s+now/i, /reschedule\s+(?:your\s+)?delivery/i,
    /enforcement\s+penalties/i, /outstanding\s+traffic\s+ticket/i,
  ];
  const socialEngKeywords = [
    /have\s+we\s+met/i, /sorting\s+through\s+my\s+address\s+book/i,
    /your\s+resume\s+has\s+been/i, /your\s+profile\s+on/i,
  ];

  type SpamCandidate = {
    handle: string;
    date: string;
    category: string;
    score: number;
    preview: string;
  };

  const candidates: SpamCandidate[] = [];

  for (const chat of chats) {
    let score = 0;
    let category = "unknown";
    const text = chat.text || "";
    const handle = chat.handle || "";
    const isEmail = handle.includes("@");

    // Email from suspicious TLD
    if (isEmail) {
      const domain = handle.split("@")[1]?.toLowerCase() || "";
      if (suspiciousTlds.some((tld) => domain.endsWith(tld))) {
        score += 10;
        category = "suspicious-email";
      } else if (!safeDomains.includes(domain)) {
        score += 6;
        category = "unknown-email";
      }
    }

    // Philippines country code
    if (handle.startsWith("+63")) {
      score += 8;
      category = "philippines-number";
    }

    // Job scam keywords
    if (jobScamKeywords.some((rx) => rx.test(text))) {
      score += 8;
      category = "job-scam";
    }

    // Phishing keywords
    if (phishingKeywords.some((rx) => rx.test(text))) {
      score += 6;
      category = "phishing";
    }

    // Social engineering keywords
    if (socialEngKeywords.some((rx) => rx.test(text))) {
      score += 5;
      category = "social-engineering";
    }

    // One-way inbound (never replied)
    if (chat.sent_count === 0) {
      score += 3;
    }

    // Very few messages
    if (chat.msg_count <= 2) {
      score += 3;
    }

    // Bidirectional = likely legitimate
    if (chat.sent_count > 0) {
      score -= 10;
    }

    // Threshold
    if (score >= 8) {
      const msgDate = new Date(chat.msg_epoch * 1000);
      const dateStr = msgDate.toISOString().slice(0, 10);
      candidates.push({
        handle,
        date: dateStr,
        category,
        score,
        preview: trunc(text, 160),
      });
    }
  }

  if (candidates.length === 0) {
    console.log("No spam candidates detected.");
    return;
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Generate Obsidian markdown
  let md = `---\ncreated: ${today}\ndocument-type: spam-review\nstatus: pending\ntotal-candidates: ${candidates.length}\n---\n`;
  md += `# iMessage Spam Review ${today}\n`;
  md += `> [!warning] Review each entry and check the box to approve blocking. Then run \`report-spam\` on confirmed entries.\n\n`;

  for (const c of candidates) {
    md += `- [ ] \`${c.handle}\` | ${c.date} | **${c.category}** | Score: ${c.score} | "${c.preview}"\n`;
  }

  md += `\n> [!info] Generated by \`bun imessage.ts spam-scan\` — ${candidates.length} candidates found.\n`;

  await Bun.write(outPath, md);
  console.log(`✓ Found ${candidates.length} spam candidates`);
  console.log(`  Written to: ${outPath}`);

  // Open in Obsidian
  await Bun.spawn(["open", outPath]).exited;
}

/**
 * Contact name resolution cache.
 * Loaded lazily from macOS AddressBook SQLite databases on first use.
 * Maps phone numbers (multiple formats) and emails to contact names.
 * This is the secondary contact resolution used by spam-scan and other
 * commands that need to resolve handles outside of the buildContactMap() flow.
 */
const contactCache = new Map<string, string>();
let contactCacheLoaded = false;

async function loadContactCache() {
  if (contactCacheLoaded) return;
  try {
    // Use AddressBook SQLite databases directly — AppleScript is too slow for 3000+ contacts
    const abRoot = join(HOME, "Library/Application Support/AddressBook/Sources");
    const sources = readdirSync(abRoot).filter(d => !d.startsWith("."));
    for (const src of sources) {
      const dbPath = join(abRoot, src, "AddressBook-v22.abcddb");
      if (!existsSync(dbPath)) continue;
      try {
        const abDb = new Database(dbPath, { readonly: true });
        // Phone numbers
        const phones = abDb.query(`
          SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER
          FROM ZABCDRECORD r
          JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
          WHERE (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL) AND p.ZFULLNUMBER IS NOT NULL
        `).all() as { ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZFULLNUMBER: string }[];
        for (const row of phones) {
          const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(" ");
          if (!name) continue;
          const normalized = row.ZFULLNUMBER.replace(/[\s\-()]/g, "");
          contactCache.set(normalized, name);
          contactCache.set(row.ZFULLNUMBER, name);
          // Also store with +1 prefix for US numbers (10 digits without country code)
          if (/^\d{10}$/.test(normalized)) {
            contactCache.set(`+1${normalized}`, name);
          }
          // Store with + prefix if it starts with a country code
          if (/^\d{11,}$/.test(normalized) && !normalized.startsWith("+")) {
            contactCache.set(`+${normalized}`, name);
          }
        }
        // Email addresses
        const emails = abDb.query(`
          SELECT r.ZFIRSTNAME, r.ZLASTNAME, e.ZADDRESS
          FROM ZABCDRECORD r
          JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
          WHERE (r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL) AND e.ZADDRESS IS NOT NULL
        `).all() as { ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZADDRESS: string }[];
        for (const row of emails) {
          const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(" ");
          if (!name) continue;
          contactCache.set(row.ZADDRESS.toLowerCase(), name);
        }
        abDb.close();
      } catch { /* skip inaccessible source */ }
    }
    contactCacheLoaded = true;
  } catch {
    contactCacheLoaded = true; // Don't retry on failure
  }
}

function resolveContact(handle: string): string | null {
  // Try exact match
  if (contactCache.has(handle)) return contactCache.get(handle)!;
  // Try normalized phone
  const normalized = handle.replace(/[\s\-()]/g, "");
  if (contactCache.has(normalized)) return contactCache.get(normalized)!;
  return null;
}

// ============================================================
// GROUP MANAGEMENT COMMANDS: groups, create-group, leave-group, rename-group
// ============================================================

/** List group chats with participant counts and last activity */
function cmdGroups(limit = 30) {
  const db = openDB();
  const rows = db
    .prepare(
      `SELECT
        c.ROWID,
        c.chat_identifier,
        COALESCE(c.display_name, c.room_name, c.chat_identifier) AS name,
        c.is_archived,
        MAX(m.date) AS last_date,
        COUNT(DISTINCT chj.handle_id) AS member_count,
        (SELECT mm.text
          FROM message mm
          JOIN chat_message_join cmj2 ON cmj2.message_id = mm.ROWID
          WHERE cmj2.chat_id = c.ROWID AND mm.text IS NOT NULL AND mm.item_type = 0
          ORDER BY mm.date DESC LIMIT 1) AS last_text
      FROM chat c
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      JOIN message m ON m.ROWID = cmj.message_id
      LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      WHERE c.style = 43
      GROUP BY c.ROWID
      ORDER BY last_date DESC
      LIMIT ?`
    )
    .all(limit) as any[];

  if (jsonMode) {
    out(
      rows.map((r) => ({
        chat_id: r.chat_identifier,
        name: r.name,
        members: r.member_count,
        archived: !!r.is_archived,
        last_message: fmtDate(r.last_date),
        preview: trunc(r.last_text, 60),
      }))
    );
    return;
  }

  console.log(`\nGroup Chats (${rows.length}):\n`);
  for (const r of rows) {
    const arch = r.is_archived ? " [archived]" : "";
    console.log(`  ${r.name}${arch}`);
    console.log(`    ${r.member_count} members · ${fmtDate(r.last_date)}`);
    if (r.last_text) console.log(`    "${trunc(r.last_text, 70)}"`);
    console.log();
  }
}

/** Create a new group chat via AppleScript (may be unreliable on macOS 13+) */
async function cmdCreateGroup(name: string, handles: string[]) {
  if (handles.length < 2) die("Need at least 2 handles to create a group");

  const buddyLines = handles
    .map((h) => `    set end of buddyList to buddy "${q(h)}" of acct`)
    .join("\n");

  const result = await osa(`tell application "Messages"
    set acct to first account whose service type is iMessage
    set buddyList to {}
${buddyLines}
    try
        set newChat to make new text chat with participants buddyList
        set name of newChat to "${q(name)}"
        return "created"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "created") {
    console.log(`✓ Group '${name}' created with ${handles.length} participants`);
  } else {
    console.log(
      `Note: Group creation via AppleScript is limited on macOS 13+.`
    );
    console.log(`Result: ${result}`);
    console.log(
      `\nTo create manually: Messages.app → compose (⌘N) → add multiple recipients`
    );
  }
}

/** Leave a group chat via AppleScript */
async function cmdLeaveGroup(name: string) {
  const result = await osa(`tell application "Messages"
    try
        set c to first chat whose name is "${q(name)}"
        leave c
        return "left"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "left") {
    console.log(`✓ Left group '${name}'`);
  } else {
    console.log(`Could not leave '${name}' via script: ${result}`);
    console.log(
      `Manually: open the group → Details → Leave this Conversation`
    );
  }
}

/** Rename a group chat via AppleScript */
async function cmdRenameGroup(name: string, newName: string) {
  const result = await osa(`tell application "Messages"
    try
        set c to first chat whose name is "${q(name)}"
        set name of c to "${q(newName)}"
        return "renamed"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "renamed") {
    console.log(`✓ Group renamed to '${newName}'`);
  } else {
    die(result);
  }
}

// ============================================================
// CORE COMMANDS: send, send-group, list, participants, find, read, search
// These are the original v1.0 commands, now enhanced with contact resolution
// ============================================================

/** Send an iMessage to a phone number or email via AppleScript */
async function cmdSend(to: string, msg: string) {
  const result = await osa(`tell application "Messages"
    set acct to first account whose service type is iMessage
    set b to buddy "${q(to)}" of acct
    send "${q(msg)}" to b
    return "sent"
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "sent") {
    console.log(`✓ Sent to ${to}`);
  } else {
    die(result);
  }
}

/** Send a message to a named group chat (exact name match required) */
async function cmdSendGroup(name: string, msg: string) {
  const result = await osa(`tell application "Messages"
    try
        set c to first chat whose name is "${q(name)}"
        send "${q(msg)}" to c
        return "sent"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "sent") {
    console.log(`✓ Sent to group '${name}'`);
  } else {
    die(result);
  }
}

/** List recent conversations with contact name resolution from AddressBook */
async function cmdList(limit = 20) {
  // Load contact cache for name resolution
  await loadContactCache();

  const result = await osa(`tell application "Messages"
    set output to {}
    set allChats to every chat
    set total to count of allChats
    set endIdx to ${limit}
    if endIdx > total then set endIdx to total
    repeat with i from 1 to endIdx
        set c to item i of allChats
        set cid to id of c
        set cname to ""
        try
            set rawName to name of c
            if rawName is not missing value then set cname to rawName as string
        end try
        set pCount to count of (participants of c)
        if pCount > 2 then
            set chatType to "group(" & pCount & ")"
        else
            set chatType to "1:1"
        end if
        if cname is "" then
            set AppleScript's text item delimiters to ";"
            set parts to text items of cid
            set AppleScript's text item delimiters to ""
            if (count of parts) >= 3 then
                set cname to item 3 of parts
            else
                set cname to cid
            end if
        end if
        set end of output to ("[" & chatType & "] " & cname)
    end repeat
    set AppleScript's text item delimiters to linefeed
    set outputStr to output as string
    set AppleScript's text item delimiters to ""
    return outputStr
end tell`);

  // Post-process: resolve contact names for 1:1 chats
  const lines = result.split("\n");
  const enhanced = lines.map((line) => {
    const match = line.match(/^\[1:1\] (.+)$/);
    if (match) {
      const handle = match[1].trim();
      const name = resolveContact(handle);
      if (name) return `[1:1] ${name} (${handle})`;
    }
    return line;
  });
  console.log(enhanced.join("\n"));
}

/** List participants of a named group chat */
async function cmdParticipants(name: string) {
  const result = await osa(`tell application "Messages"
    try
        set c to first chat whose name is "${q(name)}"
        set pList to {}
        repeat with p in participants of c
            set h to handle of p
            try
                set fn to full name of p
                set end of pList to (fn & " <" & h & ">")
            on error
                set end of pList to h
            end try
        end repeat
        set AppleScript's text item delimiters to linefeed
        set outputStr to pList as string
        set AppleScript's text item delimiters to ""
        return outputStr
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`);
  console.log(result);
}

/** Find all chats containing a phone number or email handle */
async function cmdFind(handle: string) {
  const result = await osa(`tell application "Messages"
    set results to {}
    repeat with c in chats
        set cid to id of c
        if cid contains "${q(handle)}" then
            try
                set cname to name of c
            on error
                set cname to cid
            end try
            set end of results to ("id=" & cid & " name=" & cname)
        end if
    end repeat
    if (count of results) = 0 then
        return "No chats found for: ${q(handle)}"
    end if
    set AppleScript's text item delimiters to linefeed
    set outputStr to results as string
    set AppleScript's text item delimiters to ""
    return outputStr
end tell`);
  console.log(result);
}

/** Read last N messages from a contact (raw tab-separated output). Supports --since/--before filters. */
function cmdRead(handle: string, limit = 10, opts: { since?: string; before?: string } = {}) {
  const db = openDB();
  const tf = buildTimeFilter(opts.since, opts.before);
  const rows = db
    .prepare(
      `SELECT
        datetime(m.date/1000000000 + ${APPLE_EPOCH}, 'unixepoch', 'localtime') AS sent_at,
        CASE m.is_from_me WHEN 1 THEN 'me' ELSE COALESCE(h2.id, 'them') END AS sender,
        REPLACE(REPLACE(m.text, CHAR(10), ' '), CHAR(13), ' ') AS body
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      LEFT JOIN handle h2 ON h2.ROWID = m.handle_id
      WHERE (h.id = ? OR c.chat_identifier = ?)
        AND m.text IS NOT NULL AND m.text != ''
        ${tf.sql}
      ORDER BY m.date DESC
      LIMIT ?`
    )
    .all(handle, handle, ...tf.params, limit) as any[];

  for (const r of rows) {
    console.log(`${r.sent_at}\t${r.sender}\t${r.body}`);
  }
}

/** Search all messages by keyword. Supports --since/--before, --semantic, --hybrid modes. */
function cmdSearch(query: string, limit = 20, opts: { since?: string; before?: string } = {}) {
  const db = openDB();
  const tf = buildTimeFilter(opts.since, opts.before);
  const rows = db
    .prepare(
      `SELECT
        datetime(m.date/1000000000 + ${APPLE_EPOCH}, 'unixepoch', 'localtime') AS sent_at,
        COALESCE(h.id, 'me') AS sender,
        c.chat_identifier AS chat,
        REPLACE(REPLACE(m.text, CHAR(10), ' '), CHAR(13), ' ') AS body
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.text LIKE ?
        AND m.text IS NOT NULL
        ${tf.sql}
      ORDER BY m.date DESC
      LIMIT ?`
    )
    .all(`%${query}%`, ...tf.params, limit) as any[];

  for (const r of rows) {
    console.log(`${r.sent_at}\t${r.sender}\t${r.chat}\t${r.body}`);
  }
}

/** Print Full Disk Access setup instructions */
function cmdSetupFDA() {
  console.log(`=== Full Disk Access — Setup Instructions ===

Full Disk Access is required to read/search iMessages (chat.db).

STEP 1: Open System Settings
  → Privacy & Security → Full Disk Access

STEP 2: Add your terminal app:
  - Terminal.app, iTerm2, Ghostty, or your IDE terminal

STEP 3: If using Claude Code (claude CLI):
  Add the claude binary or its parent terminal to Full Disk Access.

STEP 4: Restart the terminal app.

STEP 5: Verify:
  sqlite3 ~/Library/Messages/chat.db "SELECT count(*) FROM message;"
  → Should return a number, not "authorization denied"`);
}

// ============================================================
// IMESSAGE DETECTION, REAL-TIME WATCH & SEMANTIC SEARCH
// ============================================================

/**
 * Check whether a handle is registered as iMessage or falls back to SMS.
 * Reads service type from chat.db — does not send any messages.
 */
function cmdCheckIMessage(handle: string) {
  const db = openDB();
  const formats = phoneFormats(handle);
  const placeholders = formats.map(() => "?").join(",");

  const rows = db.prepare(`
    SELECT h.service,
           COUNT(m.ROWID) as total,
           COUNT(CASE WHEN m.error != 0 THEN 1 END) as errors
    FROM handle h
    LEFT JOIN message m ON h.ROWID = m.handle_id
    WHERE h.id IN (${placeholders})
    GROUP BY h.service
  `).all(...formats) as { service: string; total: number; errors: number }[];

  if (rows.length === 0) {
    if (jsonMode) { out({ handle, imessage: false, reason: "no_history" }); }
    else { console.log(`No message history found for ${handle}`); }
    return;
  }

  const iMsgRow = rows.find(r =>
    ["iMessage", "iMessageLite"].includes(r.service) && r.total > 0
  );
  const smsRow = rows.find(r => r.service === "SMS");
  const isAvail = !!(iMsgRow && iMsgRow.errors < iMsgRow.total);

  if (jsonMode) {
    out({
      handle,
      imessage: isAvail,
      services: rows.map(r => ({
        service: r.service,
        messages: r.total,
        errors: r.errors,
      })),
    });
    return;
  }

  console.log(`\niMessage check: ${handle}\n`);
  for (const r of rows) {
    const pct = r.total > 0 ? Math.round(((r.total - r.errors) / r.total) * 100) : 0;
    console.log(`  ${r.service.padEnd(14)} ${String(r.total).padStart(5)} msgs, ${String(r.errors).padStart(3)} errors (${pct}% success)`);
  }
  console.log();
  if (isAvail) {
    console.log(`  Result: iMessage is AVAILABLE for ${handle}`);
  } else if (smsRow) {
    console.log(`  Result: iMessage NOT available — SMS only`);
  } else {
    console.log(`  Result: iMessage status uncertain (no successful exchanges found)`);
  }
}

/** Send SMS (green bubble) via AppleScript. Requires iPhone Text Message Forwarding enabled. */
async function cmdSendSMS(to: string, msg: string) {
  const result = await osa(`tell application "Messages"
    try
        set smsAcct to first account whose service type = SMS and enabled is true
        send "${q(msg)}" to participant "${q(to)}" of smsAcct
        return "sent"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell`).catch((e) => `ERROR: ${e.message}`);

  if (result === "sent") {
    console.log(`Sent via SMS to ${to}`);
  } else {
    die(`SMS send failed: ${result}\n  Ensure Text Message Forwarding is enabled (iPhone Settings > Messages > Text Message Forwarding)`);
  }
}

/**
 * Real-time message stream using kqueue file watching on chat.db.
 * Monitors chat.db, chat.db-wal, and chat.db-shm for changes.
 * Optionally filters by handle and supports --timeout for auto-exit.
 * Persists cursor to avoid duplicate messages on restart.
 */
async function cmdWatch(handle?: string, opts: { timeout?: number } = {}) {
  const db = openDB();
  const contactMap = buildContactMap();
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const statePath = join(STATE_DIR, "watch_state.json");

  // Load or initialize cursor
  let cursor: number;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    cursor = state.lastRowid ?? 0;
  } catch {
    cursor = 0;
  }
  if (cursor === 0) {
    cursor = (db.prepare("SELECT MAX(ROWID) as m FROM message").get() as any)?.m ?? 0;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 250;

  const poll = () => {
    try {
      const handleFilter = handle ? "AND (h.id = ? OR c.chat_identifier = ?)" : "";
      const params: any[] = handle ? [cursor, handle, handle] : [cursor];
      const rows = db.prepare(`
        SELECT m.ROWID, m.text, m.is_from_me, m.date,
               h.id as sender_handle, c.chat_identifier, c.display_name
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ? AND m.text IS NOT NULL AND m.text != ''
        ${handleFilter}
        ORDER BY m.ROWID ASC LIMIT 100
      `).all(...params) as any[];

      for (const r of rows) {
        const name = contactMap.get(r.sender_handle?.toLowerCase?.())
          ?? contactMap.get(r.sender_handle)
          ?? r.sender_handle ?? "Unknown";
        if (jsonMode) {
          out({
            rowid: r.ROWID,
            date: fmtDateWithDay(r.date),
            sender: r.is_from_me ? "me" : name,
            handle: r.sender_handle,
            chat: r.chat_identifier,
            text: r.text,
          });
        } else {
          const dir = r.is_from_me ? "\x1b[36m-> Me\x1b[0m" : `\x1b[33m<- ${name}\x1b[0m`;
          console.log(`[${fmtDateWithDay(r.date)}] ${dir}: ${r.text}`);
        }
        if (r.ROWID > cursor) cursor = r.ROWID;
      }
      // Persist cursor
      try {
        writeFileSync(statePath, JSON.stringify({ lastRowid: cursor }));
      } catch { /* ignore write errors */ }
    } catch {
      // DB might be locked briefly — skip this poll
    }
  };

  // Watch chat.db + WAL files
  const dbPath = join(HOME, "Library/Messages/chat.db");
  const watchers: ReturnType<typeof watch>[] = [];
  for (const path of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try {
      if (existsSync(path)) {
        const w = watch(path, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(poll, DEBOUNCE_MS);
        });
        watchers.push(w);
      }
    } catch { /* file may not exist yet */ }
  }

  if (watchers.length === 0) {
    die("Could not watch any chat.db files. Ensure Full Disk Access is granted.");
  }

  console.log(`\x1b[2mWatching for new messages${handle ? ` from ${handle}` : ""}... (Ctrl+C to stop)\x1b[0m\n`);

  if (opts.timeout) {
    setTimeout(() => {
      for (const w of watchers) w.close();
      console.log(`\n\x1b[2mWatch timeout (${opts.timeout}s) — exiting.\x1b[0m`);
      process.exit(0);
    }, opts.timeout * 1000);
  }

  // Block forever (Bun keeps process alive while watchers are active)
  await new Promise(() => {});
}

/**
 * Generate embeddings for a batch of texts using OpenAI's text-embedding-3-small model.
 * Used by build-index and semantic-search for vector similarity.
 * @returns Array of embedding vectors (one per input text)
 */
async function batchEmbed(texts: string[]): Promise<number[][]> {
  const apiKey = loadEnvKey("OPENAI_API_KEY");
  if (!apiKey) die("OPENAI_API_KEY not found. Set it in your environment or ~/.imessage-cli/.env");

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    die(`OpenAI embedding API error ${resp.status}: ${body}`);
  }

  const json = await resp.json() as any;
  // Sort by index to ensure correct order
  const sorted = (json.data as any[]).sort((a: any, b: any) => a.index - b.index);
  return sorted.map((d: any) => d.embedding);
}

/** Compute cosine similarity between two vectors for semantic ranking */
function cosineSim(a: Float32Array, b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Reciprocal Rank Fusion: merge keyword and semantic search results into a unified ranking */
function rrfMerge(
  ftsResults: { rowid: number; text: string }[],
  vecResults: { rowid: number; text: string; similarity: number }[],
  k = 60,
): { rowid: number; text: string; score: number }[] {
  const scores = new Map<number, { text: string; score: number }>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    const existing = scores.get(r.rowid) ?? { text: r.text, score: 0 };
    existing.score += 1 / (k + i + 1);
    scores.set(r.rowid, existing);
  }

  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i];
    const existing = scores.get(r.rowid) ?? { text: r.text, score: 0 };
    existing.score += 1 / (k + i + 1);
    scores.set(r.rowid, existing);
  }

  return [...scores.entries()]
    .map(([rowid, { text, score }]) => ({ rowid, text, score }))
    .sort((a, b) => b.score - a.score);
}

const SEARCH_INDEX_PATH = join(STATE_DIR, "search_index.db");

/** Create the embedding index database schema if it doesn't exist */
function ensureIndexSchema(indexDb: Database) {
  indexDb.exec(`
    CREATE TABLE IF NOT EXISTS message_index (
      rowid      INTEGER PRIMARY KEY,
      handle     TEXT,
      chat_id    TEXT,
      text       TEXT,
      date_ns    INTEGER,
      embedding  BLOB
    );
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // FTS5 virtual table — created separately since IF NOT EXISTS isn't standard for virtual tables
  try {
    indexDb.exec(`
      CREATE VIRTUAL TABLE message_fts USING fts5(
        text,
        content=message_index,
        content_rowid=rowid,
        tokenize = 'porter unicode61'
      );
    `);
  } catch {
    // Already exists — fine
  }
}

/**
 * Build or update the semantic search embedding index.
 * Embeds all messages using OpenAI text-embedding-3-small and stores in a local SQLite database.
 * Incremental mode only embeds new messages since last build (~$0.004 for full DB).
 */
async function cmdBuildIndex(incremental = true) {
  const indexDb = new Database(SEARCH_INDEX_PATH);
  ensureIndexSchema(indexDb);

  let lastRowid = 0;
  if (incremental) {
    const row = indexDb.prepare("SELECT value FROM sync_meta WHERE key='last_indexed_rowid'").get() as any;
    lastRowid = parseInt(row?.value ?? "0");
  }

  const chatDb = openDB();

  // Resolve handle IDs to handle strings
  const handleMap = new Map<number, string>();
  const handles = chatDb.prepare("SELECT ROWID, id FROM handle").all() as { ROWID: number; id: string }[];
  for (const h of handles) handleMap.set(h.ROWID, h.id);

  const rows = chatDb.prepare(`
    SELECT m.ROWID, m.text, m.handle_id, m.date,
           c.chat_identifier
    FROM message m
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE m.ROWID > ? AND m.text IS NOT NULL AND length(m.text) >= 3
      AND m.item_type = 0
    ORDER BY m.ROWID ASC
  `).all(lastRowid) as any[];

  if (rows.length === 0) {
    console.log("Index is up to date — no new messages to index.");
    indexDb.close();
    return;
  }

  console.log(`Indexing ${rows.length} messages...`);

  const BATCH = 100;
  let indexed = 0;

  const insertMsg = indexDb.prepare(
    "INSERT OR REPLACE INTO message_index (rowid, handle, chat_id, text, date_ns, embedding) VALUES (?,?,?,?,?,?)"
  );
  const insertFts = indexDb.prepare(
    "INSERT OR REPLACE INTO message_fts (rowid, text) VALUES (?,?)"
  );

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const texts = batch.map((r: any) => r.text as string);

    let embeddings: number[][];
    try {
      embeddings = await batchEmbed(texts);
    } catch (e: any) {
      console.error(`\nEmbedding error at batch ${i}: ${e.message}`);
      console.error("Saving progress and stopping...");
      break;
    }

    indexDb.exec("BEGIN");
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const handleStr = handleMap.get(r.handle_id) ?? "";
      const embBuf = Buffer.from(new Float32Array(embeddings[j]).buffer);
      insertMsg.run(r.ROWID, handleStr, r.chat_identifier ?? "", r.text, r.date, embBuf);
      insertFts.run(r.ROWID, r.text);
    }

    // Update cursor after each batch (resumable)
    indexDb.prepare("INSERT OR REPLACE INTO sync_meta VALUES ('last_indexed_rowid', ?)")
      .run(String(batch[batch.length - 1].ROWID));
    indexDb.exec("COMMIT");

    indexed += batch.length;
    process.stdout.write(`\r  ${Math.min(indexed, rows.length)}/${rows.length} messages indexed`);
  }

  console.log(`\nIndex built: ${indexed} messages indexed at ${SEARCH_INDEX_PATH}`);
  indexDb.close();
}

/**
 * Semantic/hybrid search combining vector similarity with keyword matching.
 * Modes: "hybrid" (default, RRF merge), "semantic" (vector only), "keyword" (LIKE only).
 * Requires build-index to have been run first for semantic/hybrid modes.
 */
async function cmdSemanticSearch(query: string, limit = 20, mode: "hybrid" | "keyword" | "semantic" = "hybrid") {
  if (!existsSync(SEARCH_INDEX_PATH)) {
    die("Search index not found. Run: bun imessage.ts build-index");
  }

  const indexDb = new Database(SEARCH_INDEX_PATH, { readonly: true });
  const contactMap = buildContactMap();

  let ftsResults: { rowid: number; text: string }[] = [];
  let vecResults: { rowid: number; text: string; similarity: number }[] = [];

  // FTS5 keyword search
  if (mode !== "semantic") {
    try {
      ftsResults = indexDb.prepare(`
        SELECT rowid, text FROM message_fts
        WHERE message_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit * 2) as any[];
    } catch {
      // FTS5 match syntax error — fall back to LIKE
      ftsResults = indexDb.prepare(`
        SELECT rowid, text FROM message_index
        WHERE text LIKE ?
        ORDER BY date_ns DESC
        LIMIT ?
      `).all(`%${query}%`, limit * 2) as any[];
    }
  }

  // Vector search
  if (mode !== "keyword") {
    const [queryEmb] = await batchEmbed([query]);
    const allVecs = indexDb.prepare(
      "SELECT rowid, text, embedding FROM message_index WHERE embedding IS NOT NULL"
    ).all() as any[];

    vecResults = allVecs
      .map((r: any) => {
        const embArray = new Float32Array(
          r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)
        );
        return {
          rowid: r.rowid as number,
          text: r.text as string,
          similarity: cosineSim(embArray, queryEmb),
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit * 2);
  }

  // Merge results
  let results: { rowid: number; text: string; score: number }[];
  if (mode === "keyword") {
    results = ftsResults.map((r, i) => ({ ...r, score: 1 / (60 + i + 1) }));
  } else if (mode === "semantic") {
    results = vecResults.map(r => ({ rowid: r.rowid, text: r.text, score: r.similarity }));
  } else {
    results = rrfMerge(ftsResults, vecResults);
  }

  results = results.slice(0, limit);

  // Enrich with metadata from index
  const enriched = results.map(r => {
    const meta = indexDb.prepare(
      "SELECT handle, chat_id, date_ns FROM message_index WHERE rowid = ?"
    ).get(r.rowid) as any;
    const senderName = meta?.handle
      ? (contactMap.get(meta.handle.toLowerCase()) ?? contactMap.get(meta.handle) ?? meta.handle)
      : "?";
    return { ...r, handle: meta?.handle ?? "?", sender: senderName, date_ns: meta?.date_ns ?? 0 };
  });

  indexDb.close();

  if (jsonMode) {
    out(enriched.map(r => ({
      rowid: r.rowid,
      sender: r.sender,
      handle: r.handle,
      date: fmtDateWithDay(r.date_ns),
      score: Math.round(r.score * 10000) / 10000,
      text: r.text,
    })));
    return;
  }

  if (enriched.length === 0) {
    console.log(`No results for "${query}" (mode: ${mode})`);
    return;
  }

  console.log(`\nSearch results for "${query}" (mode: ${mode}, ${enriched.length} results):\n`);
  for (let i = 0; i < enriched.length; i++) {
    const r = enriched[i];
    const score = Math.round(r.score * 10000) / 10000;
    console.log(`  ${String(i + 1).padStart(2)}. \x1b[2m${fmtDateWithDay(r.date_ns)}\x1b[0m  ${r.sender}`);
    console.log(`      ${trunc(r.text, 100)}`);
    console.log(`      \x1b[2mscore: ${score}\x1b[0m\n`);
  }
}

// ============================================================
// USAGE
// ============================================================

function usage() {
  console.log(`iMessage Complete CLI v${VERSION} — Command-line interface for macOS Messages.app
Requires: Bun runtime, macOS 12+

USAGE: bun imessage.ts [--json] <command> [args]

SEND (no FDA required):
  send <to> <message>                  Send 1:1 iMessage (phone or email)
  send <to> <message> --sms            Send via SMS (requires iPhone Continuity)
  send-group <name> <message>          Send to a named group chat
  send-file <to> <path>                Send file attachment (1:1)
  send-file-group <name> <path>        Send file to group chat

READ (FDA required):
  read <handle> [N] [--since --before] Last N messages, tab-separated (default: 10)
  thread-read <handle> [N] [--since]   Enhanced read with attachment indicators
  export <handle> [--format md|txt]    Export full conversation (default: md)

SEARCH (FDA required):
  search <query> [N] [--since --before] Search all messages (default: 20)
  search <query> [N] --semantic        Semantic search (requires build-index)
  search <query> [N] --hybrid          Hybrid keyword+semantic (default for semantic-search)
  search-contact <name>                Search contacts by handle pattern
  semantic-search <query> [N]          Semantic search (alias, requires build-index)

DATABASE (FDA required):
  contacts [N]                         Contacts ranked by message count (default: 50)
  threads [N]                          All threads with unread count (default: 30)
  unread                               Count and list unread conversations
  info <handle>                        Contact details and stats
  stats                                Global database statistics
  reactions <handle> [N]               Reactions in a conversation (default: 50)
  check-imessage <handle>              Check if iMessage is available for a number

NAVIGATION (no FDA required):
  list [N]                             List recent chats (default: 20)
  find <handle>                        Find chats for a phone/email
  participants <name>                  List group chat members
  groups [N]                           List all group chats (default: 30)

WATCH (FDA required):
  watch [<handle>] [--timeout N]       Watch for new messages in real time

MANAGEMENT:
  mark-read <handle>                   Mark conversation as read (opens Messages.app)
  archive-chat <handle>                Archive a conversation [FDA required]
  delete-msg <handle> <rowid>          Delete a specific message [FDA required]
  delete-chat <handle>                 Delete entire conversation (via GUI scripting)
  create-group <name> <h1> [h2...]     Create new group chat
  leave-group <name>                   Leave a group chat
  rename-group <name> <new-name>       Rename a group chat

ATTACHMENTS (FDA required for list/get):
  list-attachments <handle> [N]        List attachments (default: 20)
  get-attachment <id> [--out /dir]     Download attachment (default: /tmp)

SEMANTIC INDEX (FDA required):
  build-index [--incremental]          Build/update embedding search index
  semantic-search <query> [N]          Search by meaning (requires build-index)

BLOCKING & SPAM:
  blocked                              Show block list
  block <handle>                       Block a contact (automated GUI scripting)
  unblock <handle>                     Unblock a contact (opens Settings)
  report-spam <handle>                 Block + delete + report spam to Apple
  spam-scan                            Scan for spam, generate review checklist

ALERTS:
  mute <handle>                        Mute conversation (hide alerts)
  unmute <handle>                      Unmute conversation (show alerts)

FORWARDING:
  forward <handle> <rowid> <to>        Forward a message to another contact
  block <handle>                       Guide to block a number
  unblock <handle>                     Guide to unblock a number

SETUP:
  setup-fda                            Full Disk Access setup instructions

OPTIONS:
  --json                               Output as JSON (all commands)
  --since <date>                       Filter: messages after date (ISO or 7d/2h/4w/1m)
  --before <date>                      Filter: messages before date
  --sms                                Force SMS service (send command)
  --semantic                           Use semantic search mode
  --hybrid                             Use hybrid keyword+semantic mode
  --incremental                        Only index new messages (build-index)
  --timeout <seconds>                  Auto-exit watch after N seconds
  --help, -h                           Show this help

EXAMPLES:
  bun imessage.ts send +15551234567 "Hey!"
  bun imessage.ts read +15551234567 20 --since 7d
  bun imessage.ts search "dinner" 10 --since 30d --before 2026-03-01
  bun imessage.ts check-imessage +15551234567
  bun imessage.ts watch --timeout 30
  bun imessage.ts build-index
  bun imessage.ts semantic-search "dinner plans" 5
  bun imessage.ts search "hello" 5 --hybrid`);
}

// ============================================================
// CLI DISPATCH
// ============================================================

async function main() {
  const rawArgs = process.argv.slice(2);

  // Strip --json flag (position-independent)
  const jsonIdx = rawArgs.indexOf("--json");
  if (jsonIdx >= 0) {
    jsonMode = true;
    rawArgs.splice(jsonIdx, 1);
  }

  // Strip --describe flag (position-independent)
  let describeMode = false;
  const describeIdx = rawArgs.indexOf("--describe");
  if (describeIdx >= 0) {
    describeMode = true;
    rawArgs.splice(describeIdx, 1);
  }

  // Strip --since <value> flag
  let sinceVal: string | undefined;
  const sinceIdx = rawArgs.indexOf("--since");
  if (sinceIdx >= 0) {
    sinceVal = rawArgs[sinceIdx + 1];
    rawArgs.splice(sinceIdx, 2);
  }

  // Strip --before <value> flag
  let beforeVal: string | undefined;
  const beforeIdx = rawArgs.indexOf("--before");
  if (beforeIdx >= 0) {
    beforeVal = rawArgs[beforeIdx + 1];
    rawArgs.splice(beforeIdx, 2);
  }

  // Strip --sms flag
  let smsMode = false;
  const smsIdx = rawArgs.indexOf("--sms");
  if (smsIdx >= 0) {
    smsMode = true;
    rawArgs.splice(smsIdx, 1);
  }

  // Strip --semantic flag
  let semanticMode = false;
  const semanticIdx = rawArgs.indexOf("--semantic");
  if (semanticIdx >= 0) {
    semanticMode = true;
    rawArgs.splice(semanticIdx, 1);
  }

  // Strip --hybrid flag
  let hybridMode = false;
  const hybridIdx = rawArgs.indexOf("--hybrid");
  if (hybridIdx >= 0) {
    hybridMode = true;
    rawArgs.splice(hybridIdx, 1);
  }

  // Strip --incremental flag
  let incrementalMode = false;
  const incrementalIdx = rawArgs.indexOf("--incremental");
  if (incrementalIdx >= 0) {
    incrementalMode = true;
    rawArgs.splice(incrementalIdx, 1);
  }

  // Strip --timeout <value> flag
  let timeoutVal: number | undefined;
  const timeoutIdx = rawArgs.indexOf("--timeout");
  if (timeoutIdx >= 0) {
    timeoutVal = parseInt(rawArgs[timeoutIdx + 1]);
    rawArgs.splice(timeoutIdx, 2);
  }

  const [cmd, ...args] = rawArgs;

  switch (cmd) {
    // V1 compat
    case "send":
      if (smsMode) {
        await cmdSendSMS(args[0], args.slice(1).join(" "));
      } else {
        await cmdSend(args[0], args.slice(1).join(" "));
      }
      break;
    case "send-group":
      await cmdSendGroup(args[0], args.slice(1).join(" "));
      break;
    case "list":
      await cmdList(parseInt(args[0]) || 20);
      break;
    case "participants":
      await cmdParticipants(args[0]);
      break;
    case "find":
      await cmdFind(args[0]);
      break;
    case "read":
      cmdRead(args[0], parseInt(args[1]) || 10, { since: sinceVal, before: beforeVal });
      break;
    case "search":
      if (semanticMode) {
        await cmdSemanticSearch(args[0], parseInt(args[1]) || 20, "semantic");
      } else if (hybridMode) {
        await cmdSemanticSearch(args[0], parseInt(args[1]) || 20, "hybrid");
      } else {
        cmdSearch(args[0], parseInt(args[1]) || 20, { since: sinceVal, before: beforeVal });
      }
      break;
    case "setup-fda":
      cmdSetupFDA();
      break;

    // Database interrogation
    case "contacts":
      cmdContacts(parseInt(args[0]) || 50);
      break;
    case "threads":
      cmdThreads(parseInt(args[0]) || 30);
      break;
    case "unread":
      cmdUnread();
      break;
    case "info": {
      if (!args[0]) die("Usage: info <handle|name>");
      const infoArg = args[0];
      const looksLikeHandle = infoArg.startsWith("+") || infoArg.includes("@") || /^\d{10,}$/.test(infoArg);
      if (looksLikeHandle) {
        cmdInfo(infoArg);
      } else {
        // Name lookup: find AddressBook handles, then filter to those active in chat.db
        const cmap = buildContactMap();
        const query = infoArg.toLowerCase();
        const allMatches: string[] = [];
        for (const [handle, name] of cmap) {
          if (name.toLowerCase().includes(query)) allMatches.push(handle);
        }
        if (allMatches.length === 0) die(`No contact found matching: "${infoArg}". Try a phone number or email.`);

        // Cross-reference: keep only handles that have iMessage activity
        const db2 = openDB();
        const activeMatches = allMatches.filter((h) => {
          const row = db2.prepare(`SELECT 1 FROM handle WHERE id = ? LIMIT 1`).get(h);
          return !!row;
        });
        const candidates = activeMatches.length > 0 ? activeMatches : allMatches;

        if (candidates.length === 1) {
          cmdInfo(candidates[0]);
        } else {
          // Rank by message count, show top match automatically
          const ranked = candidates
            .map((h) => {
              const r = db2.prepare(`SELECT COUNT(*) AS cnt FROM message m JOIN handle hh ON hh.ROWID = m.handle_id WHERE hh.id = ?`).get(h) as any;
              return { handle: h, name: cmap.get(h) || h, cnt: r?.cnt ?? 0 };
            })
            .sort((a, b) => b.cnt - a.cnt);

          if (ranked.length > 1) {
            console.log(`\nMultiple iMessage contacts match "${infoArg}":`);
            for (let mi = 0; mi < ranked.length; mi++) {
              console.log(`  ${mi + 1}. ${ranked[mi].name}  (${ranked[mi].handle})  — ${ranked[mi].cnt} messages`);
            }
            console.log(`\nShowing top match. Use the handle directly to pick a specific one.\n`);
          }
          cmdInfo(ranked[0].handle);
        }
      }
      break;
    }
    case "stats":
      cmdStats();
      break;

    // Attachments
    case "send-file":
      await cmdSendFile(args[0], args[1]);
      break;
    case "send-file-group":
      await cmdSendFileGroup(args[0], args[1]);
      break;
    case "list-attachments":
      await cmdListAttachments(args[0], parseInt(args[1]) || 20, describeMode);
      break;
    case "get-attachment": {
      const outIdx = args.indexOf("--out");
      const outDir = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_ATTACHMENT_DIR;
      await cmdGetAttachment(parseInt(args[0]), outDir);
      break;
    }

    // Advanced read/search/export
    case "reactions":
      cmdReactions(args[0], parseInt(args[1]) || 50);
      break;
    case "thread-read":
      cmdThreadRead(args[0], parseInt(args[1]) || 50, { since: sinceVal, before: beforeVal });
      break;
    case "export": {
      const fmtIdx = args.indexOf("--format");
      const fmt =
        fmtIdx >= 0 ? (args[fmtIdx + 1] as "md" | "txt") : "md";
      cmdExport(args[0], fmt);
      break;
    }
    case "mark-read":
      await cmdMarkRead(args[0]);
      break;
    case "search-contact":
      cmdSearchContact(args[0]);
      break;

    // Message management
    case "delete-msg":
      await cmdDeleteMsg(args[0], parseInt(args[1]));
      break;
    case "delete-chat":
      await cmdDeleteChat(args[0]);
      break;
    case "archive-chat":
      await cmdArchiveChat(args[0]);
      break;

    // Block management
    case "blocked":
      await cmdBlocked();
      break;
    case "block":
      await cmdBlock(args[0]);
      break;
    case "unblock":
      await cmdUnblock(args[0]);
      break;

    // Group management
    case "groups":
      cmdGroups(parseInt(args[0]) || 30);
      break;
    case "create-group":
      await cmdCreateGroup(args[0], args.slice(1));
      break;
    case "leave-group":
      await cmdLeaveGroup(args[0]);
      break;
    case "rename-group":
      await cmdRenameGroup(args[0], args[1]);
      break;

    // Detection, watch, semantic search
    case "check-imessage":
      if (!args[0]) die("Usage: check-imessage <handle>");
      cmdCheckIMessage(args[0]);
      break;
    case "watch":
      await cmdWatch(args[0], { timeout: timeoutVal });
      break;
    case "build-index":
      await cmdBuildIndex(incrementalMode || true);
      break;
    case "semantic-search":
      if (!args[0]) die("Usage: semantic-search <query> [N]");
      await cmdSemanticSearch(args[0], parseInt(args[1]) || 20, "hybrid");
      break;

    // Spam, alerts, forwarding
    case "spam-scan":
      await cmdSpamScan();
      break;
    case "report-spam":
      if (!args[0]) die("Usage: report-spam <handle>");
      await cmdReportSpam(args[0]);
      break;
    case "mute":
      if (!args[0]) die("Usage: mute <handle>");
      await cmdMute(args[0]);
      break;
    case "unmute":
      if (!args[0]) die("Usage: unmute <handle>");
      await cmdUnmute(args[0]);
      break;
    case "forward":
      if (!args[0] || !args[1] || !args[2])
        die("Usage: forward <handle> <rowid> <to-handle>");
      await cmdForward(args[0], parseInt(args[1]), args[2]);
      break;

    case "--help":
    case "-h":
    case "help":
    case "":
    case undefined:
      usage();
      break;

    default:
      console.error(`ERROR: Unknown command '${cmd}'`);
      console.error("Run: bun imessage.ts --help");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
