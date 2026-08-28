import React, { useState, useRef, useEffect, useMemo } from "react";
import { jsPDF } from "jspdf";

/* ---------------------------------------------------------------
   Element types, cycle order, and per-type layout (inches, mapped
   onto a real 8.5in page with 1.5in left / 1in right / 1in top+bottom
   margins — standard screenplay format).
--------------------------------------------------------------- */
const ORDER = ["scene_heading", "action", "character", "parenthetical", "dialogue", "transition"];

const LABELS = {
  scene_heading: "Scene Heading",
  action: "Action",
  character: "Character",
  parenthetical: "Parenthetical",
  dialogue: "Dialogue",
  transition: "Transition",
};

const NEXT_ON_ENTER = {
  scene_heading: "action",
  action: "action",
  character: "dialogue",
  parenthetical: "dialogue",
  dialogue: "character",
  transition: "scene_heading",
};

const UPPER_TYPES = new Set(["scene_heading", "character", "transition"]);

const EXTENSIONS = ["V.O.", "O.S.", "CONT'D", "FILTERED", "SUBTITLED", "PRE-LAP"];

const TYPE_STYLE = {
  scene_heading: { width: "100%", marginLeft: "0" },
  action: { width: "100%", marginLeft: "0" },
  character: { width: "3in", marginLeft: "2in" },
  parenthetical: { width: "2.3in", marginLeft: "1.6in" },
  dialogue: { width: "3.5in", marginLeft: "1in" },
  transition: { width: "100%", marginLeft: "0", textAlign: "right" },
};

const PLACEHOLDER = {
  scene_heading: "INT. LOCATION - DAY",
  action: "Describe the action...",
  character: "CHARACTER NAME",
  parenthetical: "(beat)",
  dialogue: "Dialogue...",
  transition: "CUT TO:",
};

let idCounter = 1;
const newId = () => `b${idCounter++}`;

/* ---------------------------------------------------------------
   Local storage — used only in "continue without cloud sync" mode:
   a single local autosave slot, no multi-script support offline.
--------------------------------------------------------------- */
const STORAGE_KEY = "slugline_screenplay_v1";
const AUTH_STORAGE_KEY = "slugline_auth_v1";

async function saveScriptData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error("Autosave failed", e);
    return false;
  }
}

async function loadScriptData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("Autosave load failed", e);
    return null;
  }
}

/* ---------------------------------------------------------------
   Cloud storage — a small library of named scripts via the Worker +
   KV API, gated by the app password. Each script has its own id.
--------------------------------------------------------------- */
async function verifyPassword(password) {
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "X-App-Password": password } });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function fetchScriptList(password) {
  try {
    const res = await fetch("/api/scripts", { headers: { "X-App-Password": password } });
    if (res.status === 401) return { unauthorized: true };
    if (!res.ok) return null;
    const data = await res.json();
    return data.scripts || [];
  } catch (e) {
    return null;
  }
}

async function createCloudScript(password) {
  try {
    const res = await fetch("/api/scripts", { method: "POST", headers: { "X-App-Password": password } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function loadCloudScript(password, id) {
  try {
    const res = await fetch(`/api/scripts/${id}`, { headers: { "X-App-Password": password } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function saveCloudScript(password, id, data) {
  try {
    const res = await fetch(`/api/scripts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-App-Password": password },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function deleteCloudScript(password, id) {
  try {
    const res = await fetch(`/api/scripts/${id}`, { method: "DELETE", headers: { "X-App-Password": password } });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Restored blocks/elements carry ids from a previous session's counter;
// bump the counter past them so newly created blocks never collide.
function bumpIdCounter(items) {
  let max = 0;
  items.forEach((it) => {
    const n = parseInt(String(it.id).replace(/[^\d]/g, ""), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  if (max + 1 > idCounter) idCounter = max + 1;
}

/* ---------------------------------------------------------------
   Fountain export
--------------------------------------------------------------- */
function generateFountain(blocks, title, author, meta = {}) {
  const out = [];
  const { credit, basedOn, draftDate, contact } = meta;
  if (title.trim() || author.trim() || credit?.trim() || basedOn?.trim() || draftDate?.trim() || contact?.trim()) {
    if (title.trim()) out.push(`Title: ${title.trim()}`);
    if (credit?.trim()) out.push(`Credit: ${credit.trim()}`);
    if (author.trim()) out.push(`Author: ${author.trim()}`);
    if (basedOn?.trim()) out.push(`Source: ${basedOn.trim()}`);
    if (draftDate?.trim()) out.push(`Draft date: ${draftDate.trim()}`);
    if (contact?.trim()) {
      const lines = contact.trim().split("\n");
      out.push(`Contact: ${lines[0]}`);
      lines.slice(1).forEach((l) => out.push(`  ${l}`));
    }
    out.push("");
  }
  let prevType = null;
  blocks.forEach((b) => {
    const text = b.text;
    if (text.trim() === "") {
      prevType = b.type;
      return;
    }
    let needBlank = true;
    if (prevType === "character" && (b.type === "dialogue" || b.type === "parenthetical")) needBlank = false;
    if (prevType === "parenthetical" && b.type === "dialogue") needBlank = false;
    if (prevType === null) needBlank = false;
    if (needBlank) out.push("");

    if (b.type === "scene_heading") {
      let t = text;
      if (!/^(INT|EXT|EST|I\/E)[. ]/i.test(t)) t = "." + t;
      out.push(t);
    } else if (b.type === "transition") {
      out.push("> " + text);
    } else if (b.type === "parenthetical") {
      let t = text.trim();
      if (!t.startsWith("(")) t = "(" + t;
      if (!t.endsWith(")")) t = t + ")";
      out.push(t);
    } else if (b.type === "character") {
      out.push(text + (b.dual ? " ^" : ""));
    } else {
      out.push(text);
    }
    prevType = b.type;
  });
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Fountain import (best-effort parser)
--------------------------------------------------------------- */
function parseFountain(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let ttl = "";
  let auth = "";
  let cred = "";
  let src = "";
  let draft = "";
  const contactLines = [];
  let lastKey = null;
  const titleRe = /^([A-Za-z ]+):\s*(.*)$/;
  while (i < lines.length && lines[i].trim() !== "") {
    const raw = lines[i];
    const isIndented = /^[ \t]/.test(raw);
    if (isIndented && lastKey) {
      if (lastKey === "contact") contactLines.push(raw.trim());
      i++;
      continue;
    }
    if (!titleRe.test(raw)) break;
    const m = raw.match(titleRe);
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === "title") {
      ttl = val;
      lastKey = "title";
    } else if (["author", "authors", "writer", "written by"].includes(key)) {
      auth = val;
      lastKey = "author";
    } else if (key === "credit") {
      cred = val;
      lastKey = "credit";
    } else if (["source", "based on"].includes(key)) {
      src = val;
      lastKey = "source";
    } else if (["draft date", "date"].includes(key)) {
      draft = val;
      lastKey = "draft";
    } else if (key === "contact" || key === "contact info") {
      if (val) contactLines.push(val);
      lastKey = "contact";
    } else {
      lastKey = null;
    }
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;

  const blocksOut = [];
  const push = (type, text, extra = {}) => blocksOut.push({ id: newId(), type, text, ...extra });
  let lastNonBlankType = null;
  let lastBlank = true;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      lastBlank = true;
      continue;
    }
    const trimmed = line.trim();
    let type;
    let content = trimmed;

    if (/^\.[^.]/.test(trimmed)) {
      type = "scene_heading";
      content = trimmed.slice(1);
    } else if (/^(INT|EXT|EST|I\/E)[. ]/i.test(trimmed)) {
      type = "scene_heading";
    } else if (/^>\s?/.test(trimmed)) {
      type = "transition";
      content = trimmed.replace(/^>\s?/, "").replace(/\s?<$/, "");
    } else if (/^[A-Z0-9 .'\-]+TO:$/.test(trimmed)) {
      type = "transition";
    } else if (/^\(.*\)$/.test(trimmed)) {
      type = "parenthetical";
    } else if (
      trimmed === trimmed.toUpperCase() &&
      /[A-Z]/.test(trimmed) &&
      trimmed.length < 40 &&
      i + 1 < lines.length &&
      lines[i + 1].trim() !== ""
    ) {
      type = "character";
    } else if (["character", "parenthetical", "dialogue"].includes(lastNonBlankType) && !lastBlank === false && !lastBlank) {
      type = "dialogue";
    } else if (["character", "parenthetical"].includes(lastNonBlankType)) {
      type = "dialogue";
    } else {
      type = "action";
    }

    if (!lastBlank && type === "action" && blocksOut.length > 0 && blocksOut[blocksOut.length - 1].type === "action") {
      blocksOut[blocksOut.length - 1].text += "\n" + content;
    } else if (type === "character") {
      const dualMatch = /\^\s*$/.test(content);
      const cleaned = dualMatch ? content.replace(/\^\s*$/, "").trim() : content;
      push(type, cleaned, dualMatch ? { dual: true } : {});
    } else {
      push(type, content);
    }
    lastNonBlankType = type;
    lastBlank = false;
  }
  if (blocksOut.length === 0) push("scene_heading", "");
  return { title: ttl, author: auth, credit: cred, basedOn: src, draftDate: draft, contact: contactLines.join("\n"), blocks: blocksOut };
}

/* ---------------------------------------------------------------
   Final Draft (.fdx) export/import.

   .fdx is XML, not a proprietary binary format — Paragraph "Type"
   values map directly onto our six element types. Export is high
   confidence. One honest caveat: dual dialogue's exact nested XML
   shape isn't consistently documented anywhere authoritative (it's
   community-reverse-engineered, and Final Draft hasn't published a
   full spec), so rather than risk emitting a malformed structure,
   dual-dialogue pairs export as plain sequential Character/Dialogue
   paragraphs — all the text survives, just not marked "simultaneous"
   in the FDX itself. Title-page fields on import are also a
   best-effort guess, since FDX title pages are just a sequence of
   centered paragraphs with no semantic tag for "this one is the
   author" vs "this one is the draft date."
--------------------------------------------------------------- */
const FDX_TYPE_MAP = {
  scene_heading: "Scene Heading",
  action: "Action",
  character: "Character",
  parenthetical: "Parenthetical",
  dialogue: "Dialogue",
  transition: "Transition",
};

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateFDX(blocks, title, author, meta = {}) {
  const { credit, basedOn, draftDate, contact } = meta;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no" ?>');
  out.push('<FinalDraft DocumentType="Script" Template="No" Version="1">');
  out.push("  <Content>");

  let sceneNum = 0;
  blocks.forEach((b) => {
    if (!b.text.trim()) return;
    const type = FDX_TYPE_MAP[b.type] || "Action";
    let numberAttr = "";
    if (b.type === "scene_heading") {
      sceneNum++;
      numberAttr = ` Number="${sceneNum}"`;
    }
    out.push(`    <Paragraph Type="${type}"${numberAttr}>`);
    out.push(`      <Text>${xmlEscape(b.text)}</Text>`);
    out.push("    </Paragraph>");
  });

  out.push("  </Content>");

  const hasTitlePage = title.trim() || author.trim() || credit?.trim() || basedOn?.trim() || draftDate?.trim() || contact?.trim();
  if (hasTitlePage) {
    out.push("  <TitlePage>");
    out.push("    <Content>");
    const centeredLine = (text) => {
      out.push('      <Paragraph Alignment="Center">');
      out.push(`        <Text>${xmlEscape(text)}</Text>`);
      out.push("      </Paragraph>");
    };
    if (title.trim()) centeredLine(title.trim());
    if (credit?.trim() || author.trim()) centeredLine(credit?.trim() || "Written by");
    if (author.trim()) centeredLine(author.trim());
    if (basedOn?.trim()) centeredLine(basedOn.trim());
    if (draftDate?.trim()) centeredLine(draftDate.trim());
    if (contact?.trim()) contact.trim().split("\n").forEach((line) => centeredLine(line));
    out.push("    </Content>");
    out.push("  </TitlePage>");
  }

  out.push("</FinalDraft>");
  return out.join("\n");
}

function parseFDX(xml) {
  const fallback = { title: "", author: "", credit: "", basedOn: "", draftDate: "", contact: "", blocks: [{ id: newId(), type: "scene_heading", text: "" }] };
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch (e) {
    return fallback;
  }
  if (doc.querySelector("parsererror")) return fallback;

  const typeMap = {
    "scene heading": "scene_heading",
    action: "action",
    character: "character",
    parenthetical: "parenthetical",
    dialogue: "dialogue",
    transition: "transition",
    shot: "action",
    general: "action",
  };

  const blocksOut = [];
  doc.querySelectorAll("Content > Paragraph").forEach((p) => {
    const rawType = (p.getAttribute("Type") || "Action").toLowerCase();
    const type = typeMap[rawType] || "action";
    const textNodes = p.querySelectorAll("Text");
    let text = "";
    if (textNodes.length > 0) {
      textNodes.forEach((tn) => (text += tn.textContent));
    } else {
      text = p.textContent || "";
    }
    text = text.trim();
    if (!text) return;
    blocksOut.push({ id: newId(), type, text });
  });
  if (blocksOut.length === 0) blocksOut.push({ id: newId(), type: "scene_heading", text: "" });

  // Title page: FDX doesn't tag which centered line means what, so
  // this is a best-effort guess — first line is the title, a line
  // matching "Written/Story/Screenplay by" is treated as the credit
  // with the next line as author, otherwise the second line is
  // assumed to be the author.
  let ttl = "", auth = "", cred = "";
  const titleLines = Array.from(doc.querySelectorAll("TitlePage Content Paragraph"))
    .map((p) => (p.querySelector("Text")?.textContent || p.textContent || "").trim())
    .filter(Boolean);
  if (titleLines.length > 0) {
    ttl = titleLines[0];
    const creditIdx = titleLines.findIndex((l, i) => i > 0 && /^(written|story|screenplay)\s+by$/i.test(l));
    if (creditIdx !== -1) {
      cred = titleLines[creditIdx];
      auth = titleLines[creditIdx + 1] || "";
    } else if (titleLines.length > 1) {
      auth = titleLines[1];
    }
  }

  return { title: ttl, author: auth, credit: cred, basedOn: "", draftDate: "", contact: "", blocks: blocksOut };
}

/* ---------------------------------------------------------------
   Tracked elements (character intros, props, sound cues manually
   marked in Action lines) + report export
--------------------------------------------------------------- */
const CATEGORIES = {
  character: "Character",
  prop: "Prop / Object",
  sound: "Sound Cue",
};

/* ---------------------------------------------------------------
   Word Association — Datamuse (api.datamuse.com), free, no API key.
   Relation codes per https://www.datamuse.com/api/
--------------------------------------------------------------- */
const WORD_ASSOC_RELATIONS = [
  { code: "rel_syn", label: "Synonyms" },
  { code: "rel_ant", label: "Antonyms" },
  { code: "rel_trg", label: "Related Words" },
  { code: "rel_gen", label: "More General" },
  { code: "rel_spc", label: "More Specific" },
  { code: "rel_rhy", label: "Rhymes" },
];

async function fetchWordAssociations(word, relCode) {
  try {
    const res = await fetch(`https://api.datamuse.com/words?${relCode}=${encodeURIComponent(word)}&max=12`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((d) => d.word);
  } catch (e) {
    return [];
  }
}

function generateElementsReport(elements, title) {
  const out = [];
  out.push(`# Element Report${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  Object.keys(CATEGORIES).forEach((cat) => {
    const items = elements.filter((e) => e.category === cat);
    if (items.length === 0) return;
    const counts = {};
    items.forEach((it) => {
      const key = it.text.trim().toUpperCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    out.push(`## ${CATEGORIES[cat]}`);
    Object.keys(counts)
      .sort()
      .forEach((key) => {
        const n = counts[key];
        const flag = n > 1 ? " — appears capitalized more than once, check continuity" : "";
        out.push(`- ${key} (${n} mention${n === 1 ? "" : "s"})${flag}`);
      });
    out.push("");
  });
  return out.join("\n");
}

function parseElementsReport(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const labelToCat = Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [v, k]));
  const elements = [];
  let currentCat = null;
  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      currentCat = labelToCat[headerMatch[1].trim()] || null;
      continue;
    }
    const itemMatch = line.match(/^-\s+(.+?)\s+\((\d+)\s+mentions?\)/);
    if (itemMatch && currentCat) {
      const text = itemMatch[1].trim();
      const count = parseInt(itemMatch[2], 10) || 1;
      for (let i = 0; i < count; i++) {
        elements.push({ id: newId(), category: currentCat, text });
      }
    }
  }
  return elements;
}

/* ---------------------------------------------------------------
   Scene report + character name consistency check
--------------------------------------------------------------- */
function computeScenes(blocks) {
  const scenes = [];
  let current = null;
  blocks.forEach((b) => {
    if (b.type === "scene_heading") {
      if (current) scenes.push(current);
      current = { heading: b.text.trim() || "(untitled scene)", characters: new Set(), wordCount: 0 };
    } else {
      if (!current) current = { heading: "(before first scene heading)", characters: new Set(), wordCount: 0 };
      if (b.type === "character") {
        const name = b.text.replace(/\s*\^\s*$/, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
        if (name) current.characters.add(name);
      }
      current.wordCount += b.text.trim() ? b.text.trim().split(/\s+/).length : 0;
    }
  });
  if (current) scenes.push(current);
  return scenes.map((s) => ({
    ...s,
    characters: Array.from(s.characters).sort(),
    pages: Math.max(0.1, Math.round((s.wordCount / 230) * 10) / 10),
  }));
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function findNameWarnings(names) {
  const unique = Array.from(new Set(names.map((n) => n.trim().toUpperCase()))).filter(Boolean);
  const warnings = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i], b = unique[j];
      const maxLen = Math.max(a.length, b.length);
      if (maxLen < 3) continue;
      const threshold = maxLen <= 4 ? 1 : 2;
      if (levenshtein(a, b) <= threshold) warnings.push([a, b]);
    }
  }
  return warnings;
}

function generateScriptReportText(scenes, warnings, title) {
  const out = [];
  const allChars = new Set();
  scenes.forEach((s) => s.characters.forEach((c) => allChars.add(c)));
  const totalPages = Math.round(scenes.reduce((sum, s) => sum + s.pages, 0) * 10) / 10;
  out.push(`# Scene Report${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  out.push(`${scenes.length} scene${scenes.length === 1 ? "" : "s"} · ${allChars.size} character${allChars.size === 1 ? "" : "s"} · ~${totalPages} pages`);
  out.push("");
  scenes.forEach((s, i) => {
    out.push(`**${i + 1}. ${s.heading}**`);
    out.push(`- Characters: ${s.characters.length ? s.characters.join(", ") : "—"}`);
    out.push(`- Est. length: ~${s.pages} page${s.pages === 1 ? "" : "s"}`);
    out.push("");
  });
  if (warnings.length > 0) {
    out.push("## Possible Name Inconsistencies");
    warnings.forEach(([a, b]) => out.push(`- "${a}" vs "${b}" — check if these are meant to be the same character`));
    out.push("");
  }
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Scene units — groups blocks into one chunk per scene (heading +
   everything until the next heading) for the corkboard/outline view.
   A unit with headingId === null holds any content before the first
   scene heading and is always pinned first, non-reorderable.
--------------------------------------------------------------- */
function computeSceneUnits(blocks) {
  const units = [];
  let current = null;
  blocks.forEach((b) => {
    if (b.type === "scene_heading") {
      if (current) units.push(current);
      current = { headingId: b.id, heading: b.text.trim() || "(untitled scene)", blocks: [b] };
    } else {
      if (!current) current = { headingId: null, heading: "(before first scene)", blocks: [] };
      current.blocks.push(b);
    }
  });
  if (current) units.push(current);
  return units;
}

function getUnitCharacters(unitBlocks) {
  const set = new Set();
  unitBlocks.forEach((b) => {
    if (b.type === "character") {
      const name = b.text.replace(/\s*\^\s*$/, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
      if (name) set.add(name);
    }
  });
  return Array.from(set).sort();
}

/* ---------------------------------------------------------------
   Dialogue statistics — word/line count per speaking character.
--------------------------------------------------------------- */
function computeDialogueStats(blocks) {
  const stats = {};
  let currentCharacter = null;
  blocks.forEach((b) => {
    if (b.type === "character") {
      currentCharacter = b.text.replace(/\s*\^\s*$/, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
      if (currentCharacter && !stats[currentCharacter]) stats[currentCharacter] = { words: 0, lines: 0 };
    } else if (b.type === "dialogue" && currentCharacter) {
      const words = b.text.trim() ? b.text.trim().split(/\s+/).length : 0;
      if (words > 0) {
        stats[currentCharacter].words += words;
        stats[currentCharacter].lines += 1;
      }
    } else if (b.type !== "parenthetical") {
      currentCharacter = null;
    }
  });
  const totalWords = Object.values(stats).reduce((s, v) => s + v.words, 0);
  return Object.entries(stats)
    .map(([name, v]) => ({ name, ...v, pct: totalWords ? Math.round((v.words / totalWords) * 1000) / 10 : 0 }))
    .sort((a, b) => b.words - a.words);
}

function generateDialogueStatsText(stats, title) {
  const out = [];
  out.push(`# Dialogue Statistics${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  const totalWords = stats.reduce((s, v) => s + v.words, 0);
  out.push(`${stats.length} speaking character${stats.length === 1 ? "" : "s"} · ${totalWords} total dialogue words`);
  out.push("");
  stats.forEach((s, i) => {
    out.push(`${i + 1}. **${s.name}** — ${s.words} words across ${s.lines} line${s.lines === 1 ? "" : "s"} (${s.pct}% of dialogue)`);
  });
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Breakdown report — locations, day/night, interior/exterior, and
   character scene-counts (distinct from dialogue word-counts).
--------------------------------------------------------------- */
function parseSceneHeadingParts(heading) {
  const parts = heading.split(" - ");
  const timeOfDay = parts.length > 1 ? parts[parts.length - 1].trim().toUpperCase() : "";
  const rest = parts.length > 1 ? parts.slice(0, -1).join(" - ") : heading;
  const m = rest.match(/^(INT\.\/EXT\.|I\/E\.|INT\.|EXT\.|EST\.)\s*(.*)$/i);
  const intExt = m ? m[1].toUpperCase() : "";
  const location = m ? m[2].trim() : rest.trim();
  return { intExt, location, timeOfDay };
}

function normalizeIntExt(raw) {
  const r = raw.toUpperCase();
  if (r.startsWith("INT") && r.includes("EXT")) return "INT/EXT";
  if (r.startsWith("I/E")) return "INT/EXT";
  if (r.startsWith("EXT")) return "EXT";
  if (r.startsWith("INT") || r.startsWith("EST")) return "INT";
  return "(unspecified)";
}

function normalizeTimeOfDay(raw) {
  if (!raw) return "(unspecified)";
  if (raw.includes("DAY")) return "DAY";
  if (raw.includes("NIGHT")) return "NIGHT";
  return raw;
}

function computeBreakdown(scenes) {
  const locations = {};
  const dayNight = {};
  const intExt = {};
  const characterScenes = {};

  scenes.forEach((s) => {
    const { intExt: ie, location, timeOfDay } = parseSceneHeadingParts(s.heading);
    const locKey = location || "(unspecified)";
    locations[locKey] = (locations[locKey] || 0) + 1;

    const todKey = normalizeTimeOfDay(timeOfDay);
    dayNight[todKey] = (dayNight[todKey] || 0) + 1;

    const ieKey = normalizeIntExt(ie);
    intExt[ieKey] = (intExt[ieKey] || 0) + 1;

    s.characters.forEach((name) => {
      characterScenes[name] = (characterScenes[name] || 0) + 1;
    });
  });

  const toSortedArray = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  return {
    locations: toSortedArray(locations),
    dayNight: toSortedArray(dayNight),
    intExt: toSortedArray(intExt),
    characterScenes: toSortedArray(characterScenes),
  };
}

function generateBreakdownText(breakdown, title) {
  const out = [];
  out.push(`# Script Breakdown${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  out.push("## Locations");
  breakdown.locations.forEach(([loc, n]) => out.push(`- ${loc}: ${n} scene${n === 1 ? "" : "s"}`));
  out.push("");
  out.push("## Day / Night");
  breakdown.dayNight.forEach(([k, n]) => out.push(`- ${k}: ${n} scene${n === 1 ? "" : "s"}`));
  out.push("");
  out.push("## Interior / Exterior");
  breakdown.intExt.forEach(([k, n]) => out.push(`- ${k}: ${n} scene${n === 1 ? "" : "s"}`));
  out.push("");
  out.push("## Characters by Scene Count");
  breakdown.characterScenes.forEach(([name, n]) => out.push(`- ${name}: ${n} scene${n === 1 ? "" : "s"}`));
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Step outline export — free-form scene-by-scene notes, entirely
   separate from both the script content and the corkboard's
   auto-derived cards.
--------------------------------------------------------------- */
function generateOutlineText(stepOutline, title) {
  const out = [];
  out.push(`# Outline${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  stepOutline.forEach((entry, i) => {
    out.push(`## ${i + 1}. ${entry.heading.trim() || "(untitled)"}`);
    if (entry.body.trim()) out.push(entry.body.trim());
    out.push("");
  });
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Character bible — notes per character, separate from the Elements
   tracker (which is about capitalization/continuity, not narrative).
--------------------------------------------------------------- */
function generateCharacterBibleText(characterBible, title) {
  const out = [];
  out.push(`# Character Bible${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  characterBible.forEach((entry) => {
    out.push(`## ${entry.name.trim() || "(unnamed)"}${entry.age.trim() ? ` (${entry.age.trim()})` : ""}`);
    if (entry.description.trim()) out.push(entry.description.trim());
    if (entry.arc.trim()) {
      out.push("");
      out.push(`**Arc:** ${entry.arc.trim()}`);
    }
    out.push("");
  });
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Beat sheet templates — pre-fill the free-form Outline with a
   known story structure's beats as starting placeholders.
--------------------------------------------------------------- */
const OUTLINE_TEMPLATES = {
  saveTheCat: {
    name: "Save the Cat",
    description: "Blake Snyder's 15-beat system, precise about roughly where each beat lands across a script. Popular for how specific and actionable it is.",
    examples: ["Legally Blonde", "The Lion King"],
    beats: [
      "Opening Image", "Theme Stated", "Set-Up", "Catalyst", "Debate",
      "Break Into Two", "B Story", "Fun and Games", "Midpoint",
      "Bad Guys Close In", "All Is Lost", "Dark Night of the Soul",
      "Break Into Three", "Finale", "Final Image",
    ],
  },
  threeAct: {
    name: "Three-Act Structure",
    description: "The classic setup / confrontation / resolution shape under most mainstream film and TV. Flexible and forgiving — a solid default.",
    examples: ["Star Wars: A New Hope", "Jaws"],
    beats: [
      "Opening Image / Status Quo", "Inciting Incident", "Plot Point 1 (End of Act 1)",
      "Rising Action", "Midpoint", "Plot Point 2 (End of Act 2)",
      "Climax", "Falling Action", "Resolution",
    ],
  },
  herosJourney: {
    name: "Hero's Journey",
    description: "Joseph Campbell's monomyth — a hero leaves the ordinary world, is transformed through trials, and returns changed. Best for mythic, transformation-driven stories.",
    examples: ["Star Wars", "The Lord of the Rings"],
    beats: [
      "Ordinary World", "Call to Adventure", "Refusal of the Call", "Meeting the Mentor",
      "Crossing the Threshold", "Tests, Allies, Enemies", "Approach to the Inmost Cave",
      "Ordeal", "Reward", "The Road Back", "Resurrection", "Return with the Elixir",
    ],
  },
  freytag: {
    name: "Freytag's Pyramid",
    description: "A five-part dramatic arc from 19th-century analysis of Greek and Shakespearean tragedy — exposition rises to a climax, then falls to resolution.",
    examples: ["Jaws", "The Shawshank Redemption"],
    beats: ["Exposition", "Rising Action", "Climax", "Falling Action", "Resolution / Dénouement"],
  },
  fichtean: {
    name: "Fichtean Curve",
    description: "Skips the setup and drops straight into a string of escalating crises leading to one big climax. Common in thrillers, mysteries, and action.",
    examples: ["Skyfall", "Mad Max: Fury Road"],
    beats: ["Crisis 1", "Crisis 2", "Crisis 3", "Climax", "Falling Action", "Resolution"],
  },
  storyCircle: {
    name: "Dan Harmon Story Circle",
    description: "A simplified 8-step take on the Hero's Journey, developed for TV writing (Community, Rick and Morty). Circular — the character ends up back where they started, but changed.",
    examples: ["Finding Nemo", "The Matrix"],
    beats: ["You (comfort zone)", "Need", "Go (cross the threshold)", "Search", "Find", "Take", "Return", "Change"],
  },
  sevenPoint: {
    name: "7-Point Story Structure",
    description: "Dan Wells' structure, built backward from the ending: figure out your climax and hook first, then the turns and pinch points that connect them.",
    examples: ["The Matrix", "Harry Potter and the Sorcerer's Stone"],
    beats: ["Hook", "Plot Turn 1", "Pinch Point 1", "Midpoint", "Pinch Point 2", "Plot Turn 2", "Resolution"],
  },
};

/* ---------------------------------------------------------------
   Crutch word detector — flags overused non-common words across
   Action and Dialogue text (excludes stopwords and character names).
--------------------------------------------------------------- */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "been", "being", "have", "has", "had",
  "having", "this", "that", "these", "those", "with", "from", "into", "onto", "over",
  "under", "again", "then", "than", "just", "only", "very", "such", "same", "some",
  "any", "each", "both", "more", "most", "other", "what", "which", "who", "whom",
  "when", "where", "why", "how", "there", "here", "about", "after", "before",
  "through", "during", "above", "below", "between", "against", "because", "does",
  "did", "done", "not", "you", "your", "his", "her", "him", "she", "they", "them",
  "their", "himself", "herself", "itself", "themselves", "will", "would", "shall",
  "should", "could", "can", "cant", "dont", "isnt", "wasnt", "arent", "into",
]);

function computeCrutchWords(blocks, characterNames) {
  const nameSet = new Set(characterNames.map((n) => n.toLowerCase()));
  const counts = {};
  blocks.forEach((b) => {
    if (b.type !== "action" && b.type !== "dialogue") return;
    const words = b.text.toLowerCase().match(/[a-z']+/g) || [];
    words.forEach((w) => {
      if (w.length < 4) return;
      if (STOPWORDS.has(w)) return;
      if (nameSet.has(w)) return;
      counts[w] = (counts[w] || 0) + 1;
    });
  });
  return Object.entries(counts)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
}

function generateCrutchWordsText(crutchWords, title) {
  const out = [];
  out.push(`# Word Usage${title.trim() ? " — " + title.trim() : ""}`);
  out.push("");
  if (crutchWords.length === 0) {
    out.push("No notably repeated words found.");
  } else {
    out.push("Words repeated 3+ times in Action/Dialogue (excluding common words and character names):");
    out.push("");
    crutchWords.forEach(([word, n]) => out.push(`- ${word} — ${n} times`));
  }
  return out.join("\n");
}

/* ---------------------------------------------------------------
   Weak action-line detector — lightweight heuristics for passive
   voice, progressive tense, and hedging verbs in Action lines.
--------------------------------------------------------------- */
function detectWeakAction(text) {
  if (/\b(is|are|was|were|be|been|being)\s+[a-z]+ing\b/i.test(text)) {
    return "Progressive tense — consider a direct action verb";
  }
  if (/\b(is|are|was|were|be|been|being)\s+[a-z]+ed\b/i.test(text)) {
    return "Passive voice — consider who's doing the action";
  }
  if (/\b(starts?|begins?|attempts?|tries?)\s+to\b/i.test(text)) {
    return "Hedging verb — consider the direct action instead";
  }
  return null;
}

/* ---------------------------------------------------------------
   Writing goals — day-boundary and streak math for the daily
   word-count tracker.
--------------------------------------------------------------- */
function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + "T00:00:00");
  const b = new Date(dateStrB + "T00:00:00");
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

/* ---------------------------------------------------------------
   Find & Replace — flat search across all blocks' text.
--------------------------------------------------------------- */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatches(blocks, query) {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), "gi");
  const matches = [];
  blocks.forEach((b) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(b.text)) !== null) {
      matches.push({ blockId: b.id, start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  });
  return matches;
}

/* ---------------------------------------------------------------
   Table read — assigns each character a consistent voice (from
   whatever the browser's speechSynthesis exposes) so the same
   character sounds the same throughout a read, narrator voice for
   scene headings/action. voiceMap is mutated in place so
   assignments persist across the whole session, not just one read.
--------------------------------------------------------------- */
function getVoiceForCharacter(name, voices, voiceMap) {
  if (voiceMap[name]) return voiceMap[name];
  if (voices.length === 0) return null;
  const used = new Set(Object.values(voiceMap).map((v) => v?.name));
  const available = voices.filter((v) => !used.has(v.name));
  const pool = available.length > 0 ? available : voices;
  const voice = pool[Object.keys(voiceMap).length % pool.length] || voices[0];
  voiceMap[name] = voice;
  return voice;
}

function characterNameFor(text) {
  return text.replace(/\s*\^\s*$/, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/* ---------------------------------------------------------------
   Groups blocks for rendering: pairs a Character marked "dual"
   with the immediately preceding character+dialogue group so they
   can render as two side-by-side columns.
--------------------------------------------------------------- */
function buildPageGroups(blocks) {
  const groups = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "character") {
      const body = [];
      let j = i + 1;
      while (j < blocks.length && (blocks[j].type === "dialogue" || blocks[j].type === "parenthetical")) {
        body.push(blocks[j]);
        j++;
      }
      const cue = { kind: "cue", character: b, body };
      const prev = groups[groups.length - 1];
      if (b.dual && prev && prev.kind === "cue") {
        groups.pop();
        groups.push({ kind: "dual", left: prev, right: cue });
      } else {
        groups.push(cue);
      }
      i = j;
    } else {
      groups.push({ kind: "single", block: b });
      i++;
    }
  }
  return groups;
}

/* ---------------------------------------------------------------
   PDF export — real text (not a rasterized screenshot), using
   jsPDF's built-in Courier font at the same margins/indents as the
   on-screen page, including dual dialogue as side-by-side columns.
--------------------------------------------------------------- */
const PDF_PAGE_W = 8.5;
const PDF_PAGE_H = 11;
const PDF_MARGIN_TOP = 1;
const PDF_MARGIN_BOTTOM = 1;
const PDF_MARGIN_LEFT = 1.5;
const PDF_MARGIN_RIGHT = 1;
const PDF_CONTENT_WIDTH = PDF_PAGE_W - PDF_MARGIN_LEFT - PDF_MARGIN_RIGHT;
const PDF_LINE_H = 1 / 6; // 6 lines per inch — standard screenplay spacing

const PDF_LAYOUT = {
  scene_heading: { left: 0, width: PDF_CONTENT_WIDTH },
  action: { left: 0, width: PDF_CONTENT_WIDTH },
  character: { left: 2, width: 3 },
  parenthetical: { left: 1.6, width: 2.3 },
  dialogue: { left: 1, width: 3.5 },
  transition: { left: 0, width: PDF_CONTENT_WIDTH },
};

function buildScreenplayPdf(blocks, title, author, showSceneNumbers, meta = {}) {
  const doc = new jsPDF({ unit: "in", format: "letter" });
  doc.setFont("courier", "normal");
  doc.setFontSize(12);

  const { credit, basedOn, draftDate, contact } = meta;
  const hasTitlePage = title.trim() || author.trim() || credit?.trim() || basedOn?.trim() || draftDate?.trim() || contact?.trim();

  if (hasTitlePage) {
    doc.setFont("courier", "bold");
    doc.text(title.trim() || "Untitled", PDF_PAGE_W / 2, 3.6, { align: "center" });
    doc.setFont("courier", "normal");
    let ty = 4.3;
    if (credit?.trim() || author.trim()) {
      doc.text(credit?.trim() || "by", PDF_PAGE_W / 2, ty, { align: "center" });
      ty += 0.3;
    }
    if (author.trim()) {
      doc.text(author.trim(), PDF_PAGE_W / 2, ty, { align: "center" });
      ty += 0.3;
    }
    if (basedOn?.trim()) {
      ty += 0.3;
      doc.text(basedOn.trim(), PDF_PAGE_W / 2, ty, { align: "center" });
    }

    doc.setFontSize(10);
    if (draftDate?.trim()) {
      doc.text(draftDate.trim(), PDF_PAGE_W - PDF_MARGIN_RIGHT, PDF_PAGE_H - 0.9, { align: "right" });
    }
    if (contact?.trim()) {
      const lines = contact.trim().split("\n");
      let cy = PDF_PAGE_H - 0.9 - (lines.length - 1) * 0.18;
      lines.forEach((ln) => {
        doc.text(ln, PDF_MARGIN_LEFT - 0.3, cy);
        cy += 0.18;
      });
    }
    doc.setFontSize(12);

    doc.addPage();
  }

  let y = PDF_MARGIN_TOP;
  let sceneNum = 0;

  const ensureRoom = (linesNeeded) => {
    if (y + linesNeeded * PDF_LINE_H > PDF_PAGE_H - PDF_MARGIN_BOTTOM) {
      doc.addPage();
      y = PDF_MARGIN_TOP;
    }
  };

  const writeBlock = (b, leftOverride, widthOverride) => {
    if (!b.text.trim()) return;
    const left = PDF_MARGIN_LEFT + (leftOverride ?? PDF_LAYOUT[b.type].left);
    const width = widthOverride ?? PDF_LAYOUT[b.type].width;
    doc.setFont("courier", b.type === "character" || b.type === "scene_heading" ? "bold" : "normal");
    const lines = doc.splitTextToSize(b.text, width);
    if (b.type === "transition") {
      ensureRoom(lines.length);
      lines.forEach((ln) => {
        doc.text(ln, PDF_MARGIN_LEFT + PDF_CONTENT_WIDTH, y, { align: "right" });
        y += PDF_LINE_H;
      });
      return;
    }
    ensureRoom(lines.length);
    lines.forEach((ln) => {
      doc.text(ln, left, y);
      y += PDF_LINE_H;
    });
  };

  const groups = buildPageGroups(blocks);
  let first = true;
  groups.forEach((g) => {
    if (!first) y += PDF_LINE_H;
    first = false;

    if (g.kind === "single") {
      if (g.block.type === "scene_heading" && g.block.text.trim()) {
        sceneNum++;
        ensureRoom(1);
        if (showSceneNumbers) {
          doc.setFont("courier", "normal");
          doc.text(String(sceneNum), PDF_MARGIN_LEFT - 0.45, y);
          doc.text(String(sceneNum), PDF_MARGIN_LEFT + PDF_CONTENT_WIDTH + 0.3, y);
        }
      }
      writeBlock(g.block);
    } else if (g.kind === "cue") {
      writeBlock(g.character);
      g.body.forEach((bl) => writeBlock(bl));
    } else {
      const leftCol = { left: 0, width: 2.8 };
      const rightCol = { left: 3.2, width: 2.8 };
      const yStart = y;
      writeBlock(g.left.character, leftCol.left, leftCol.width);
      g.left.body.forEach((bl) => writeBlock(bl, leftCol.left, leftCol.width));
      const yAfterLeft = y;
      y = yStart;
      writeBlock(g.right.character, rightCol.left, rightCol.width);
      g.right.body.forEach((bl) => writeBlock(bl, rightCol.left, rightCol.width));
      y = Math.max(yAfterLeft, y);
    }
  });

  return doc;
}

/* ---------------------------------------------------------------
   Component
--------------------------------------------------------------- */
export default function ScreenplayEditor() {
  const [title, setTitle] = useState("Untitled Screenplay");
  const [author, setAuthor] = useState("");
  const [credit, setCredit] = useState("Written by");
  const [basedOn, setBasedOn] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [contact, setContact] = useState("");
  const [showTitlePage, setShowTitlePage] = useState(false);
  const [blocks, setBlocks] = useState([{ id: newId(), type: "scene_heading", text: "" }]);
  const [focusedId, setFocusedId] = useState(blocks[0].id);
  const [pendingFocus, setPendingFocus] = useState(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [sceneListCollapsed, setSceneListCollapsed] = useState(false);
  const [elements, setElements] = useState([]);
  const [stepOutline, setStepOutline] = useState([]);
  const [characterBible, setCharacterBible] = useState([]);
  const [sceneNotes, setSceneNotes] = useState({});
  const [showSceneNoteFor, setShowSceneNoteFor] = useState(null);
  const [availableVoices, setAvailableVoices] = useState([]);
  const [isReading, setIsReading] = useState(false);
  const [readingBlockId, setReadingBlockId] = useState(null);
  const [activeSelection, setActiveSelection] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [wordAssocStage, setWordAssocStage] = useState(null); // null | "relations" | "results"
  const [wordAssocRelation, setWordAssocRelation] = useState(null);
  const [wordAssocResults, setWordAssocResults] = useState([]);
  const [wordAssocLoading, setWordAssocLoading] = useState(false);
  const [wordAssocError, setWordAssocError] = useState("");
  const [showReportsPanel, setShowReportsPanel] = useState(false);
  const [reportsTab, setReportsTab] = useState("scenes");
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [loaded, setLoaded] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [showAppearance, setShowAppearance] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);
  const [showSceneNumbers, setShowSceneNumbers] = useState(false);
  const [showWeakActionHints, setShowWeakActionHints] = useState(true);
  const [zenMode, setZenMode] = useState(false);
  const [dailyGoal, setDailyGoal] = useState(500);
  const [wordsToday, setWordsToday] = useState(0);
  const [streak, setStreak] = useState(0);
  const [showGoalPanel, setShowGoalPanel] = useState(false);
  const [viewMode, setViewMode] = useState("script"); // "script" | "corkboard" | "outline"
  const [authed, setAuthed] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [appPassword, setAppPassword] = useState(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [currentScriptId, setCurrentScriptId] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [scriptList, setScriptList] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const fileInputRef = useRef(null);
  const elementsFileInputRef = useRef(null);
  const textRefs = useRef({});
  const autosaveTimer = useRef(null);
  const dragIndexRef = useRef(null);
  const justDraggedRef = useRef(false);
  const outlineDragIndexRef = useRef(null);
  const bibleDragIndexRef = useRef(null);
  const voiceMapRef = useRef({});
  const narratorVoiceRef = useRef(null);
  const readQueueRef = useRef([]);
  const readIndexRef = useRef(0);
  const stoppedRef = useRef(false);
  const prevWordCountRef = useRef(null);
  const justSwitchedScriptRef = useRef(true);
  const prevBlocksRef = useRef(null);
  const historyBaseRef = useRef(null);
  const historyTimerRef = useRef(null);
  const skipNextHistoryRef = useRef(false);

  const resize = (el) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  useEffect(() => {
    Object.values(textRefs.current).forEach(resize);
  }, [blocks]);

  // Undo/redo history — coalesces rapid typing into a single step by
  // only committing a checkpoint after blocks has been stable for a
  // moment, so Undo reverts a "burst" of changes rather than one
  // keystroke at a time.
  useEffect(() => {
    const prev = prevBlocksRef.current;
    prevBlocksRef.current = blocks;

    if (skipNextHistoryRef.current) {
      skipNextHistoryRef.current = false;
      return;
    }
    if (prev === null || prev === blocks) return;

    if (historyBaseRef.current === null) {
      historyBaseRef.current = prev;
    }
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = setTimeout(() => {
      const base = historyBaseRef.current;
      historyBaseRef.current = null;
      setUndoStack((prevStack) => {
        const next = [...prevStack, base];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
      setRedoStack([]);
    }, 600);
  }, [blocks]);

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, blocks]);
    setUndoStack((u) => u.slice(0, -1));
    skipNextHistoryRef.current = true;
    historyBaseRef.current = null;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    setBlocks(last);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const last = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, blocks]);
    setRedoStack((r) => r.slice(0, -1));
    skipNextHistoryRef.current = true;
    historyBaseRef.current = null;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    setBlocks(last);
  };

  // Global shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo,
  // Ctrl/Cmd+F opens Find & Replace. Undo/redo only take over the script's
  // own history when focus is on one of the script body fields (or nothing
  // editable) — if focus is in Title/Author/Find/Title Page/Outline/Bible
  // fields, the browser's native per-field undo is left alone instead of
  // being silently overridden.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape" && zenMode) {
        setZenMode(false);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === "z" || key === "y") {
        const active = document.activeElement;
        const isScriptField = Object.values(textRefs.current).includes(active);
        const isOtherEditable = !isScriptField && active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
        if (isOtherEditable) return; // let the browser handle undo/redo natively here
      }

      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        handleRedo();
      } else if (key === "f") {
        e.preventDefault();
        setShowFind(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Load/persist the appearance theme (separate from script content).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      if (raw) setTheme(JSON.parse(raw));
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    } catch (e) {
      // ignore
    }
  }, [theme]);

  // Load available text-to-speech voices (some browsers load this async).
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        setAvailableVoices(voices);
        if (!narratorVoiceRef.current) narratorVoiceRef.current = voices[0];
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // Load/persist small display preferences (scene numbers etc).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (raw) {
        const prefs = JSON.parse(raw);
        if (typeof prefs.showSceneNumbers === "boolean") setShowSceneNumbers(prefs.showSceneNumbers);
        if (typeof prefs.showWeakActionHints === "boolean") setShowWeakActionHints(prefs.showWeakActionHints);
      }
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ showSceneNumbers, showWeakActionHints }));
    } catch (e) {
      // ignore
    }
  }, [showSceneNumbers, showWeakActionHints]);

  // Load the daily writing-goal tracker, resolving day boundaries and streak.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(GOAL_STORAGE_KEY);
      const today = new Date().toISOString().slice(0, 10);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.dailyGoal === "number") setDailyGoal(saved.dailyGoal);
      if (saved.date === today) {
        setWordsToday(saved.wordsToday || 0);
        setStreak(saved.streak || 0);
      } else {
        const gap = daysBetween(saved.date, today);
        const metGoal = (saved.wordsToday || 0) >= (saved.dailyGoal || 500);
        setWordsToday(0);
        setStreak(gap === 1 && metGoal ? (saved.streak || 0) + 1 : 0);
      }
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      localStorage.setItem(GOAL_STORAGE_KEY, JSON.stringify({ dailyGoal, wordsToday, streak, date: today }));
    } catch (e) {
      // ignore
    }
  }, [dailyGoal, wordsToday, streak]);

  // Check for a remembered password on first mount.
  useEffect(() => {
    let cancelled = false;
    let stored = null;
    try {
      stored = localStorage.getItem(AUTH_STORAGE_KEY);
    } catch (e) {
      // ignore
    }
    if (!stored) {
      setAuthChecking(false);
      return;
    }
    verifyPassword(stored).then((ok) => {
      if (cancelled) return;
      if (ok) {
        setAppPassword(stored);
        setAuthed(true);
      } else {
        try {
          localStorage.removeItem(AUTH_STORAGE_KEY);
        } catch (e) {
          // ignore
        }
      }
      setAuthChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!passwordInput) return;
    setAuthBusy(true);
    setAuthError("");
    const ok = await verifyPassword(passwordInput);
    setAuthBusy(false);
    if (ok) {
      try {
        localStorage.setItem(AUTH_STORAGE_KEY, passwordInput);
      } catch (e) {
        // ignore
      }
      setAppPassword(passwordInput);
      setAuthed(true);
      setPasswordInput("");
    } else {
      setAuthError("Incorrect password, or the cloud backend isn't set up yet.");
    }
  };

  const handleContinueOffline = () => {
    setAppPassword(null);
    setAuthed(true);
  };

  const handleLogout = () => {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (e) {
      // ignore
    }
    setAppPassword(null);
    setAuthed(false);
    setLoaded(false);
    setCurrentScriptId(null);
    setShowPicker(false);
    setScriptList([]);
  };

  // Populate the editor from a full script record (from open or create).
  const openScriptData = (data, id) => {
    bumpIdCounter([...(data.blocks || []), ...(data.elements || []), ...(data.stepOutline || []), ...(data.characterBible || [])]);
    const restoredBlocks = data.blocks && data.blocks.length ? data.blocks : [{ id: newId(), type: "scene_heading", text: "" }];
    justSwitchedScriptRef.current = true;
    setTitle(data.title || "Untitled Screenplay");
    setAuthor(data.author || "");
    setCredit(data.credit || "Written by");
    setBasedOn(data.basedOn || "");
    setDraftDate(data.draftDate || "");
    setContact(data.contact || "");
    setBlocks(restoredBlocks);
    setElements(data.elements || []);
    setStepOutline(data.stepOutline || []);
    setCharacterBible(data.characterBible || []);
    setSceneNotes(data.sceneNotes || {});
    setFocusedId(restoredBlocks[0].id);
    setLastSaved(data.savedAt || null);
    setCurrentScriptId(id);
    setShowPicker(false);
    setLoaded(true);
  };

  // Immediately push any pending changes, bypassing the debounce —
  // used before navigating away from the currently open script.
  const flushSave = () => {
    if (!loaded || !authed || !appPassword || !currentScriptId) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const savedAt = new Date().toISOString();
    saveCloudScript(appPassword, currentScriptId, { title, author, credit, basedOn, draftDate, contact, blocks, elements, stepOutline, characterBible, sceneNotes, savedAt }).then((ok) => {
      if (ok) setLastSaved(savedAt);
    });
  };

  const handleOpenScript = async (id) => {
    setPickerLoading(true);
    setPickerError("");
    const data = await loadCloudScript(appPassword, id);
    setPickerLoading(false);
    if (data) openScriptData(data, id);
    else setPickerError("Couldn't open that script.");
  };

  const handleNewCloudScript = async () => {
    setPickerLoading(true);
    setPickerError("");
    const created = await createCloudScript(appPassword);
    setPickerLoading(false);
    if (created) {
      openScriptData(created, created.id);
      setScriptList((prev) => [{ id: created.id, title: created.title, updatedAt: created.savedAt }, ...prev]);
    } else {
      setPickerError("Couldn't create a new script.");
    }
  };

  const handleDeleteScript = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this script? This can't be undone.")) return;
    const ok = await deleteCloudScript(appPassword, id);
    if (ok) {
      setScriptList((prev) => prev.filter((s) => s.id !== id));
      if (currentScriptId === id) setCurrentScriptId(null);
    }
  };

  // After login: cloud mode shows the script picker; offline mode
  // restores the single local autosave slot as before.
  useEffect(() => {
    if (!authed) return;
    if (appPassword) {
      setShowPicker(true);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    loadScriptData().then((data) => {
      if (cancelled) return;
      if (!data) {
        setLoaded(true);
        return;
      }
      bumpIdCounter([...(data.blocks || []), ...(data.elements || []), ...(data.stepOutline || []), ...(data.characterBible || [])]);
      const restoredBlocks = data.blocks && data.blocks.length ? data.blocks : [{ id: newId(), type: "scene_heading", text: "" }];
      justSwitchedScriptRef.current = true;
      setTitle(data.title || "Untitled Screenplay");
      setAuthor(data.author || "");
      setCredit(data.credit || "Written by");
      setBasedOn(data.basedOn || "");
      setDraftDate(data.draftDate || "");
      setContact(data.contact || "");
      setBlocks(restoredBlocks);
      setElements(data.elements || []);
      setStepOutline(data.stepOutline || []);
      setCharacterBible(data.characterBible || []);
      setSceneNotes(data.sceneNotes || {});
      setFocusedId(restoredBlocks[0].id);
      if (data.savedAt) setLastSaved(data.savedAt);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [authed, appPassword]);

  // Fetch the script list whenever the picker is opened in cloud mode.
  useEffect(() => {
    if (!showPicker || !appPassword) return;
    let cancelled = false;
    setPickerLoading(true);
    setPickerError("");
    fetchScriptList(appPassword).then((list) => {
      if (cancelled) return;
      setPickerLoading(false);
      if (list && list.unauthorized) {
        handleLogout();
        setAuthError("Your session is no longer valid — please log in again.");
        return;
      }
      if (list) setScriptList(list);
      else setPickerError("Couldn't load your scripts.");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPicker, appPassword]);

  // Debounced autosave whenever the script changes.
  useEffect(() => {
    if (!loaded || !authed) return;
    if (appPassword && !currentScriptId) return; // cloud mode, nothing open yet
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const savedAt = new Date().toISOString();
      if (appPassword && currentScriptId) {
        saveCloudScript(appPassword, currentScriptId, { title, author, credit, basedOn, draftDate, contact, blocks, elements, stepOutline, characterBible, sceneNotes, savedAt }).then((ok) => {
          if (ok) {
            setLastSaved(savedAt);
            setScriptList((prev) => prev.map((s) => (s.id === currentScriptId ? { ...s, title, updatedAt: savedAt } : s)));
          }
        });
      } else {
        saveScriptData({ title, author, credit, basedOn, draftDate, contact, blocks, elements, stepOutline, characterBible, sceneNotes, savedAt }).then((ok) => {
          if (ok) setLastSaved(savedAt);
        });
      }
    }, 800);
    return () => clearTimeout(autosaveTimer.current);
  }, [blocks, title, author, credit, basedOn, draftDate, contact, elements, stepOutline, characterBible, sceneNotes, loaded, authed, appPassword, currentScriptId]);

  useEffect(() => {
    if (!pendingFocus) return;
    const el = textRefs.current[pendingFocus.id];
    if (el) {
      el.focus();
      let pos = 0;
      if (pendingFocus.pos === "end") pos = el.value.length;
      else if (pendingFocus.pos === "at") pos = pendingFocus.at;
      el.setSelectionRange(pos, pos);
      resize(el);
    }
    setPendingFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, blocks]);

  const updateText = (id, val) => {
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        const isUpper = UPPER_TYPES.has(b.type);
        const v = isUpper ? val.toUpperCase() : val;
        // Typing while in an uppercase type means the old pre-uppercase
        // backup no longer applies — this is now the "real" content.
        return { ...b, text: v, caseBackup: isUpper ? undefined : b.caseBackup };
      })
    );
  };

  const setType = (id, type) => {
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        const wasUpper = UPPER_TYPES.has(b.type);
        const willUpper = UPPER_TYPES.has(type);
        let text = b.text;
        let caseBackup = b.caseBackup;

        if (!wasUpper && willUpper) {
          // Entering an uppercase type: remember the original casing.
          caseBackup = b.text;
          text = b.text.toUpperCase();
        } else if (wasUpper && !willUpper) {
          // Leaving an uppercase type: restore original casing, but only
          // if nothing was typed since it was uppercased (can't reliably
          // un-uppercase text the user actually wrote while it was upper).
          if (caseBackup != null && b.text === caseBackup.toUpperCase()) {
            text = caseBackup;
          }
          caseBackup = undefined;
        }
        // Upper-to-upper (e.g. Character -> Scene Heading) keeps the
        // existing backup untouched so it can still restore correctly
        // whenever it eventually lands on a non-uppercase type.

        return { ...b, type, text, caseBackup };
      })
    );
    setPendingFocus({ id, pos: "end" });
  };

  const toggleExtension = (id, ext) => {
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        const stripped = b.text.replace(/\s*\([^()]*\)\s*$/, "").trimEnd();
        const match = b.text.match(/\(([^()]*)\)\s*$/);
        const current = match ? match[1].trim().toUpperCase() : null;
        const text = current === ext ? stripped : `${stripped} (${ext})`;
        return { ...b, text };
      })
    );
    setPendingFocus({ id, pos: "end" });
  };

  const toggleDual = (id) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, dual: !b.dual } : b)));
  };

  const knownCharacterNames = useMemo(() => {
    const set = new Set();
    blocks.forEach((b) => {
      if (b.type === "character") {
        const name = b.text.replace(/\s*\^\s*$/, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
        if (name) set.add(name);
      }
    });
    return Array.from(set).sort();
  }, [blocks]);

  const charactersNotInBible = useMemo(() => {
    const existing = new Set(characterBible.map((e) => e.name.trim().toUpperCase()));
    return knownCharacterNames.filter((n) => !existing.has(n.toUpperCase()));
  }, [knownCharacterNames, characterBible]);

  const knownSceneHeadings = useMemo(() => {
    const set = new Set();
    blocks.forEach((b) => {
      if (b.type === "scene_heading" && b.text.trim()) set.add(b.text.trim());
    });
    return Array.from(set).sort();
  }, [blocks]);

  const scenes = useMemo(() => computeScenes(blocks), [blocks]);

  const nameWarnings = useMemo(() => {
    const allNames = [...knownCharacterNames, ...elements.filter((e) => e.category === "character").map((e) => e.text)];
    return findNameWarnings(allNames);
  }, [knownCharacterNames, elements]);

  const sceneNumberMap = useMemo(() => {
    const map = {};
    let n = 0;
    blocks.forEach((b) => {
      if (b.type === "scene_heading") {
        n++;
        map[b.id] = n;
      }
    });
    return map;
  }, [blocks]);

  const sceneUnits = useMemo(() => computeSceneUnits(blocks), [blocks]);

  const dialogueStats = useMemo(() => computeDialogueStats(blocks), [blocks]);

  const breakdown = useMemo(() => computeBreakdown(scenes), [scenes]);

  const crutchWords = useMemo(() => computeCrutchWords(blocks, knownCharacterNames), [blocks, knownCharacterNames]);

  const matches = useMemo(() => findMatches(blocks, findQuery), [blocks, findQuery]);

  useEffect(() => {
    if (matchIndex >= matches.length) setMatchIndex(Math.max(0, matches.length - 1));
  }, [matches, matchIndex]);

  const gotoMatch = (idx) => {
    if (matches.length === 0) return;
    const clamped = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIndex(clamped);
    const m = matches[clamped];
    const el = textRefs.current[m.blockId];
    if (el) {
      el.focus();
      el.setSelectionRange(m.start, m.end);
      if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
    }
  };

  const handleFindNext = () => gotoMatch(matchIndex + 1);
  const handleFindPrev = () => gotoMatch(matchIndex - 1);

  const handleReplaceOne = () => {
    if (matches.length === 0) return;
    const m = matches[matchIndex];
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== m.blockId) return b;
        const newText = b.text.slice(0, m.start) + replaceQuery + b.text.slice(m.end);
        return { ...b, text: UPPER_TYPES.has(b.type) ? newText.toUpperCase() : newText };
      })
    );
  };

  const handleReplaceAll = () => {
    if (!findQuery) return;
    const lowerQuery = findQuery.toLowerCase();
    const escaped = escapeRegExp(findQuery);
    setBlocks((prev) =>
      prev.map((b) => {
        if (!b.text.toLowerCase().includes(lowerQuery)) return b;
        const re = new RegExp(escaped, "gi");
        const newText = b.text.replace(re, replaceQuery);
        return { ...b, text: UPPER_TYPES.has(b.type) ? newText.toUpperCase() : newText };
      })
    );
  };

  const handleExportBreakdown = () => {
    const text = generateBreakdownText(breakdown, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_breakdown.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportCrutchWords = () => {
    const text = generateCrutchWordsText(crutchWords, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_word_usage.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUpdateSceneNote = (blockId, text) => {
    setSceneNotes((prev) => ({ ...prev, [blockId]: text }));
  };

  const handleExportOutline = () => {
    const text = generateOutlineText(stepOutline, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_outline.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getSuggestionsFor = (block) => {
    if (!block) return [];
    if (block.type === "character") {
      const q = block.text.trim().toUpperCase();
      if (!q) return [];
      return knownCharacterNames.filter((n) => n.toUpperCase().startsWith(q) && n.toUpperCase() !== q).slice(0, 5);
    }
    if (block.type === "scene_heading") {
      const q = block.text.trim().toUpperCase();
      if (!q) return ["INT. ", "EXT. ", "INT./EXT. "];
      return knownSceneHeadings.filter((h) => h.toUpperCase().startsWith(q) && h.toUpperCase() !== q).slice(0, 6);
    }
    return [];
  };

  const handleExportScriptReport = () => {
    const text = generateScriptReportText(scenes, nameWarnings, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_scenes.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportDialogueStats = () => {
    const text = generateDialogueStatsText(dialogueStats, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_dialogue.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCardDragStart = (e, idx) => {
    dragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleCardDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleCardDrop = (e, idx) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    if (from === null || from === idx) return;
    setBlocks((prevBlocks) => {
      const units = computeSceneUnits(prevBlocks);
      const leading = units[0] && units[0].headingId === null ? units[0] : null;
      const reorderable = leading ? units.slice(1) : units;
      const arr = [...reorderable];
      const [moved] = arr.splice(from, 1);
      arr.splice(idx, 0, moved);
      const newUnits = leading ? [leading, ...arr] : arr;
      return newUnits.flatMap((u) => u.blocks);
    });
    justDraggedRef.current = true;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
  };

  const handleCardClick = (headingId) => {
    if (justDraggedRef.current || !headingId) return;
    setViewMode("script");
    setPendingFocus({ id: headingId, pos: "start" });
  };

  const handleAddOutlineEntry = () => {
    setStepOutline((prev) => [...prev, { id: newId(), heading: "", body: "" }]);
  };

  const handleApplyOutlineTemplate = (key) => {
    const tmpl = OUTLINE_TEMPLATES[key];
    if (!tmpl) return;
    if (stepOutline.length > 0 && !window.confirm("This will replace your current outline entries. Continue?")) return;
    setStepOutline(tmpl.beats.map((heading) => ({ id: newId(), heading, body: "" })));
  };

  const handleUpdateOutlineEntry = (id, field, value) => {
    setStepOutline((prev) => prev.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)));
  };

  const handleDeleteOutlineEntry = (id) => {
    setStepOutline((prev) => prev.filter((entry) => entry.id !== id));
  };

  const handleOutlineDragStart = (e, idx) => {
    outlineDragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleOutlineDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleOutlineDrop = (e, idx) => {
    e.preventDefault();
    const from = outlineDragIndexRef.current;
    outlineDragIndexRef.current = null;
    if (from === null || from === idx) return;
    setStepOutline((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(idx, 0, moved);
      return arr;
    });
  };

  const handleAddBibleEntry = (name = "") => {
    setCharacterBible((prev) => [...prev, { id: newId(), name, age: "", description: "", arc: "" }]);
  };

  const handleUpdateBibleEntry = (id, field, value) => {
    setCharacterBible((prev) => prev.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)));
  };

  const handleDeleteBibleEntry = (id) => {
    setCharacterBible((prev) => prev.filter((entry) => entry.id !== id));
  };

  const handleBibleDragStart = (e, idx) => {
    bibleDragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleBibleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleBibleDrop = (e, idx) => {
    e.preventDefault();
    const from = bibleDragIndexRef.current;
    bibleDragIndexRef.current = null;
    if (from === null || from === idx) return;
    setCharacterBible((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(idx, 0, moved);
      return arr;
    });
  };

  const handleExportCharacterBible = () => {
    const text = generateCharacterBibleText(characterBible, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_character_bible.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const markElement = (blockId, start, end, category) => {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const selected = block.text.slice(start, end);
    if (!selected.trim()) return;
    const newText = block.text.slice(0, start) + selected.toUpperCase() + block.text.slice(end);
    setBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, text: newText } : b)));
    setElements((prev) => [...prev, { id: newId(), category, text: selected.trim() }]);
    setActiveSelection(null);
    closeContextMenu();
    setPendingFocus({ id: blockId, pos: "at", at: end });
  };

  const removeElement = (id) => {
    setElements((prev) => prev.filter((e) => e.id !== id));
  };

  const handleExportElements = () => {
    const text = generateElementsReport(elements, title);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}_elements.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSelect = (e, block) => {
    const { selectionStart: s, selectionEnd: en } = e.target;
    if (s !== en) setActiveSelection({ blockId: block.id, start: s, end: en });
    else if (activeSelection?.blockId === block.id) setActiveSelection(null);
  };

  const handleContextMenu = (e, block) => {
    const { selectionStart: s, selectionEnd: en } = e.target;
    if (s === en) return; // no selection: allow the browser's normal menu
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, blockId: block.id, blockType: block.type, start: s, end: en });
  };

  const resolveVoiceForBlock = (block) => {
    if (availableVoices.length === 0) return null;
    let characterName = null;
    if (block.type === "character") {
      characterName = characterNameFor(block.text);
    } else if (block.type === "dialogue" || block.type === "parenthetical") {
      const idx = blocks.findIndex((b) => b.id === block.id);
      for (let i = idx - 1; i >= 0; i--) {
        if (blocks[i].type === "character") {
          characterName = characterNameFor(blocks[i].text);
          break;
        }
        if (blocks[i].type !== "parenthetical" && blocks[i].type !== "dialogue") break;
      }
    }
    if (characterName) return getVoiceForCharacter(characterName, availableVoices, voiceMapRef.current);
    return narratorVoiceRef.current || availableVoices[0];
  };

  const speakNext = () => {
    if (stoppedRef.current) return;
    const queue = readQueueRef.current;
    const idx = readIndexRef.current;
    if (idx >= queue.length) {
      setIsReading(false);
      setReadingBlockId(null);
      return;
    }
    const block = queue[idx];
    setReadingBlockId(block.id);
    const utter = new SpeechSynthesisUtterance(block.text);
    const voice = resolveVoiceForBlock(block);
    if (voice) utter.voice = voice;
    utter.onend = () => {
      if (stoppedRef.current) return;
      readIndexRef.current += 1;
      speakNext();
    };
    utter.onerror = () => {
      if (stoppedRef.current) return;
      readIndexRef.current += 1;
      speakNext();
    };
    window.speechSynthesis.speak(utter);
  };

  const handleTableRead = (startBlockId) => {
    if (!("speechSynthesis" in window)) {
      window.alert("Text-to-speech isn't supported in this browser.");
      return;
    }
    stoppedRef.current = true; // swallow the onend from any read already in progress
    window.speechSynthesis.cancel();
    const startIdx = startBlockId ? Math.max(blocks.findIndex((b) => b.id === startBlockId), 0) : 0;
    readQueueRef.current = blocks.slice(startIdx).filter((b) => b.text.trim() && ["scene_heading", "action", "dialogue"].includes(b.type));
    readIndexRef.current = 0;
    stoppedRef.current = false;
    setIsReading(true);
    speakNext();
  };

  const handleStopReading = () => {
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    setIsReading(false);
    setReadingBlockId(null);
  };

  const closeContextMenu = () => {
    setContextMenu(null);
    setWordAssocStage(null);
    setWordAssocRelation(null);
    setWordAssocResults([]);
    setWordAssocError("");
  };

  const handleWordAssocRelation = async (relCode, relLabel) => {
    if (!contextMenu) return;
    const block = blocks.find((b) => b.id === contextMenu.blockId);
    if (!block) return;
    const word = block.text.slice(contextMenu.start, contextMenu.end).trim();
    setWordAssocRelation(relLabel);
    setWordAssocStage("results");
    setWordAssocLoading(true);
    setWordAssocError("");
    setWordAssocResults([]);
    const results = await fetchWordAssociations(word, relCode);
    setWordAssocLoading(false);
    if (results.length === 0) setWordAssocError("No results found.");
    setWordAssocResults(results);
  };

  const handleApplyWordAssoc = (word) => {
    if (!contextMenu) return;
    const { blockId, start, end } = contextMenu;
    setBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== blockId) return b;
        const newText = b.text.slice(0, start) + word + b.text.slice(end);
        return { ...b, text: UPPER_TYPES.has(b.type) ? newText.toUpperCase() : newText };
      })
    );
    closeContextMenu();
  };

  const handleReadAloudSelection = (sel) => {
    const block = blocks.find((b) => b.id === sel.blockId);
    closeContextMenu();
    if (!block) return;
    const text = block.text.slice(sel.start, sel.end);
    if (!text.trim()) return;
    if (!("speechSynthesis" in window)) {
      window.alert("Text-to-speech isn't supported in this browser.");
      return;
    }
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    stoppedRef.current = false;
    const utter = new SpeechSynthesisUtterance(text);
    const voice = resolveVoiceForBlock(block);
    if (voice) utter.voice = voice;
    setReadingBlockId(block.id);
    utter.onstart = () => setIsReading(true);
    utter.onend = () => {
      if (stoppedRef.current) return;
      setIsReading(false);
      setReadingBlockId(null);
    };
    window.speechSynthesis.speak(utter);
  };

  const handleKeyDown = (e, id) => {
    const idx = blocks.findIndex((b) => b.id === id);
    const block = blocks[idx];
    const el = e.target;

    const suggestions = getSuggestionsFor(block);
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestIndex((i) => Math.max(i - 1, -1));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && suggestIndex >= 0) {
        e.preventDefault();
        const chosen = suggestions[suggestIndex];
        updateText(id, chosen);
        setSuggestIndex(-1);
        return;
      }
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const curIdx = ORDER.indexOf(block.type);
      const nextIdx = e.shiftKey ? (curIdx - 1 + ORDER.length) % ORDER.length : (curIdx + 1) % ORDER.length;
      setType(id, ORDER[nextIdx]);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const nid = newId();
      const nextType = NEXT_ON_ENTER[block.type] || "action";
      setBlocks((prev) => {
        const copy = [...prev];
        copy.splice(idx + 1, 0, { id: nid, type: nextType, text: "" });
        return copy;
      });
      setPendingFocus({ id: nid, pos: "start" });
      return;
    }

    if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (idx > 0) {
        e.preventDefault();
        const prevBlock = blocks[idx - 1];
        if (block.text === "") {
          setBlocks((prev) => prev.filter((b) => b.id !== id));
          setPendingFocus({ id: prevBlock.id, pos: "end" });
        } else {
          const mergeAt = prevBlock.text.length;
          setBlocks((prev) =>
            prev.filter((b) => b.id !== id).map((b) => (b.id === prevBlock.id ? { ...b, text: b.text + block.text } : b))
          );
          setPendingFocus({ id: prevBlock.id, pos: "at", at: mergeAt });
        }
      }
      return;
    }

    if (e.key === "ArrowUp" && el.selectionStart === 0 && idx > 0) {
      e.preventDefault();
      setPendingFocus({ id: blocks[idx - 1].id, pos: "end" });
      return;
    }
    if (e.key === "ArrowDown" && el.selectionStart === el.value.length && idx < blocks.length - 1) {
      e.preventDefault();
      setPendingFocus({ id: blocks[idx + 1].id, pos: "start" });
    }
  };

  const handleNew = () => {
    if (appPassword) {
      flushSave();
      handleNewCloudScript();
      return;
    }
    if (!window.confirm("Start a new script? Unsaved changes will be lost.")) return;
    const id = newId();
    const blank = [{ id, type: "scene_heading", text: "" }];
    setBlocks(blank);
    setTitle("Untitled Screenplay");
    setAuthor("");
    setCredit("Written by");
    setBasedOn("");
    setDraftDate("");
    setContact("");
    setElements([]);
    setStepOutline([]);
    setCharacterBible([]);
    setSceneNotes({});
    setPendingFocus({ id, pos: "start" });
    saveScriptData({ title: "Untitled Screenplay", author: "", credit: "Written by", basedOn: "", draftDate: "", contact: "", blocks: blank, elements: [], stepOutline: [], characterBible: [], sceneNotes: {}, savedAt: new Date().toISOString() });
  };

  const handleSave = () => {
    const text = generateFountain(blocks, title, author, { credit, basedOn, draftDate, contact });
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}.fountain`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportPDF = () => {
    const doc = buildScreenplayPdf(blocks, title, author, showSceneNumbers, { credit, basedOn, draftDate, contact });
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    doc.save(`${safe}.pdf`);
  };

  const handleExportFDX = () => {
    const text = generateFDX(blocks, title, author, { credit, basedOn, draftDate, contact });
    const blob = new Blob([text], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (title.trim() || "screenplay").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "screenplay";
    a.href = url;
    a.download = `${safe}.fdx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleLoadClick = () => fileInputRef.current?.click();

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isFdx = /\.fdx$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result);
      const { title: t, author: a, credit: c, basedOn: bo, draftDate: dd, contact: ct, blocks: b } = isFdx ? parseFDX(raw) : parseFountain(raw);
      const newTitle = t || file.name.replace(/\.[^.]+$/, "");
      setTitle(newTitle);
      setAuthor(a || "");
      setCredit(c || "Written by");
      setBasedOn(bo || "");
      setDraftDate(dd || "");
      setContact(ct || "");
      setBlocks(b);
      setPendingFocus({ id: b[0].id, pos: "start" });
      const savedAt = new Date().toISOString();
      const payload = { title: newTitle, author: a || "", credit: c || "Written by", basedOn: bo || "", draftDate: dd || "", contact: ct || "", blocks: b, elements, stepOutline, characterBible, sceneNotes, savedAt };
      if (appPassword && currentScriptId) {
        saveCloudScript(appPassword, currentScriptId, payload).then((ok) => {
          if (ok) setLastSaved(savedAt);
        });
      } else {
        saveScriptData(payload);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleLoadElementsClick = () => elementsFileInputRef.current?.click();

  const handleElementsFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (elements.length > 0 && !window.confirm("Replace currently tracked elements with this file?")) {
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setElements(parseElementsReport(String(reader.result)));
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const wordCount = blocks.reduce((sum, b) => sum + (b.text.trim() ? b.text.trim().split(/\s+/).length : 0), 0);
  const pageEstimate = Math.max(1, Math.round(wordCount / 230));

  // Track today's writing progress: count only forward-progress deltas
  // (typing), not deletions, and never count switching to a different
  // script's word total as "words written."
  useEffect(() => {
    if (justSwitchedScriptRef.current) {
      justSwitchedScriptRef.current = false;
      prevWordCountRef.current = wordCount;
      return;
    }
    if (prevWordCountRef.current === null) {
      prevWordCountRef.current = wordCount;
      return;
    }
    const delta = wordCount - prevWordCountRef.current;
    prevWordCountRef.current = wordCount;
    if (delta > 0) setWordsToday((w) => w + delta);
  }, [wordCount]);

  const focusedType = blocks.find((b) => b.id === focusedId)?.type || "action";

  const styles = useMemo(() => buildStyles(theme), [theme]);
  const globalCss = useMemo(() => buildGlobalCss(theme), [theme]);
  const mutedColor = useMemo(() => mix(theme.ink, theme.text, 0.55), [theme]);
  const lineColor = useMemo(() => mix(theme.ink, theme.text, 0.14), [theme]);
  const sceneHeadingColor = useMemo(() => mix(theme.gold, "#1a1a1a", 0.35), [theme]);

  const renderField = (b, dualMode = false) => {
    const isFocused = b.id === focusedId;
    const suggestions = isFocused ? getSuggestionsFor(b) : [];
    const typeStyle = dualMode ? { width: "100%", marginLeft: "0" } : TYPE_STYLE[b.type];
    const sceneNum = !dualMode && b.type === "scene_heading" ? sceneNumberMap[b.id] : null;
    const missingTOD = b.type === "scene_heading" && b.text.trim() && !parseSceneHeadingParts(b.text).timeOfDay;
    const weakReason = showWeakActionHints && b.type === "action" && b.text.trim() ? detectWeakAction(b.text) : null;
    return (
      <div key={b.id} style={{ position: "relative" }}>
        {showSceneNumbers && sceneNum && (
          <>
            <span style={{ ...styles.sceneNumberBadge, left: "-0.55in" }}>{sceneNum}</span>
            <span style={{ ...styles.sceneNumberBadge, right: "-0.65in" }}>{sceneNum}</span>
          </>
        )}
        {missingTOD && (
          <span style={styles.todWarning} title="No DAY/NIGHT (or other time cue) specified">⚠ DAY/NIGHT?</span>
        )}
        {weakReason && (
          <span style={styles.weakActionBadge} title={weakReason}>✎ weak</span>
        )}
        <textarea
          ref={(el) => (textRefs.current[b.id] = el)}
          value={b.text}
          placeholder={PLACEHOLDER[b.type]}
          className={b.type === "scene_heading" ? "scene-heading-field" : undefined}
          onFocus={() => {
            setFocusedId(b.id);
            setSuggestIndex(-1);
          }}
          onSelect={(e) => handleSelect(e, b)}
          onContextMenu={(e) => handleContextMenu(e, b)}
          onChange={(e) => {
            updateText(b.id, e.target.value);
            setSuggestIndex(-1);
            resize(e.target);
          }}
          onKeyDown={(e) => handleKeyDown(e, b.id)}
          rows={1}
          spellCheck={b.type === "action" || b.type === "dialogue"}
          style={{
            ...styles.line,
            ...typeStyle,
            fontWeight: b.type === "character" || b.type === "scene_heading" ? 700 : 400,
            color: b.type === "scene_heading" ? sceneHeadingColor : styles.line.color,
            background: b.id === readingBlockId ? `${theme.gold}22` : "transparent",
          }}
        />
        {suggestions.length > 0 && (
          <div style={{ ...styles.suggestDropdown, marginLeft: typeStyle.marginLeft, minWidth: "1.6in", maxWidth: "3in", width: "max-content" }}>
            {suggestions.map((s, i) => (
              <div
                key={s + i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  updateText(b.id, s);
                  setSuggestIndex(-1);
                  setTimeout(() => textRefs.current[b.id]?.focus(), 0);
                }}
                style={{ ...styles.suggestItem, ...(i === suggestIndex ? styles.suggestItemActive : {}) }}
              >
                {s}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderMenu = (key, label, items) => (
    <div style={{ position: "relative" }}>
      <button style={styles.btn} onClick={() => setOpenMenu(openMenu === key ? null : key)}>
        {label} ▾
      </button>
      {openMenu === key && (
        <>
          <div style={styles.menuOverlay} className="no-print" onClick={() => setOpenMenu(null)} />
          <div style={styles.dropdownMenu} className="no-print">
            {items.map((it, i) =>
              it.divider ? (
                <div key={i} style={styles.menuDivider} />
              ) : it.header ? (
                <div key={i} style={styles.menuSectionLabel}>{it.header}</div>
              ) : (
                <button
                  key={i}
                  style={styles.dropdownItem}
                  onClick={() => {
                    it.onClick();
                    setOpenMenu(null);
                  }}
                >
                  {it.checkbox !== undefined && <span style={styles.checkbox}>{it.checkbox ? "✓" : ""}</span>}
                  {it.label}
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div style={styles.app}>
      <style>{globalCss}</style>

      {authChecking ? (
        <div style={styles.authWrap}>
          <span style={styles.brandMark}>⟡</span>
        </div>
      ) : !authed ? (
        <div style={styles.authWrap}>
          <form style={styles.authCard} onSubmit={handleLogin}>
            <div style={styles.brand}>
              <span style={styles.brandMark}>⟡</span>
              <span style={styles.brandText}>SLUGLINE</span>
            </div>
            <p style={styles.authHint}>Enter the password to sync your script to the cloud.</p>
            <input
              type="password"
              autoFocus
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Password"
              style={styles.authInput}
            />
            {authError && <div style={styles.authError}>{authError}</div>}
            <button type="submit" style={styles.btnPrimary} disabled={authBusy}>
              {authBusy ? "Checking…" : "Log In"}
            </button>
            <button type="button" style={styles.authSkip} onClick={handleContinueOffline}>
              Continue without cloud sync
            </button>
          </form>
        </div>
      ) : showPicker ? (
        <div style={styles.authWrap}>
          <div style={styles.pickerCard}>
            <div style={styles.panelHeader}>
              <span style={styles.brandText}>YOUR SCRIPTS</span>
              <div style={{ display: "flex", gap: "8px" }}>
                {currentScriptId && (
                  <button style={styles.btn} onClick={() => setShowPicker(false)}>Back</button>
                )}
                <button style={styles.btn} onClick={handleLogout}>Log Out</button>
              </div>
            </div>
            <button style={{ ...styles.btnPrimary, width: "100%", marginBottom: "14px" }} onClick={handleNewCloudScript} disabled={pickerLoading}>
              + New Script
            </button>
            {pickerError && <div style={styles.authError}>{pickerError}</div>}
            {pickerLoading && scriptList.length === 0 && <div style={{ color: mutedColor, fontSize: "13px" }}>Loading…</div>}
            {!pickerLoading && scriptList.length === 0 && !pickerError && (
              <div style={{ color: mutedColor, fontSize: "13px" }}>No scripts yet — create your first one above.</div>
            )}
            <div style={{ maxHeight: "50vh", overflowY: "auto", padding: "2px" }}>
              {scriptList.map((s) => (
                <div key={s.id} onClick={() => handleOpenScript(s.id)} style={styles.scriptRow} className="script-row">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "13.5px" }}>{s.title || "Untitled Screenplay"}</div>
                    <div style={{ fontSize: "11px", color: mutedColor, marginTop: "3px" }}>
                      {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}
                    </div>
                  </div>
                  <button style={styles.elementRemove} onClick={(e) => handleDeleteScript(s.id, e)} title="Delete">×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
      <>
      {/* Header */}
      {!zenMode && (
      <div style={styles.header} className="no-print">
        <div style={styles.brand}>
          <span style={styles.brandMark}>⟡</span>
          <span style={styles.brandText}>SLUGLINE</span>
        </div>

        <div style={styles.titleFields}>
          <input
            style={styles.titleInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled Screenplay"
          />
          <input
            style={styles.authorInput}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author"
          />
        </div>

        <div style={styles.headerActions}>
          {renderMenu("file", "File", [
            { label: "New", onClick: handleNew },
            { label: "Load Script… (.fountain/.fdx)", onClick: handleLoadClick },
            ...(appPassword ? [{ label: "My Scripts…", onClick: () => { flushSave(); setShowPicker(true); } }] : []),
            { divider: true },
            { label: "Title Page…", onClick: () => setShowTitlePage(true) },
            { divider: true },
            { label: "Save .fountain", onClick: handleSave },
            { label: "Export PDF", onClick: handleExportPDF },
            { label: "Export .fdx (Final Draft)", onClick: handleExportFDX },
            { divider: true },
            { label: "Print", onClick: () => window.print() },
            { divider: true },
            { label: appPassword ? "Log Out" : "Log In…", onClick: appPassword ? handleLogout : () => setAuthed(false) },
          ])}
          {renderMenu("edit", "Edit", [
            { label: `Undo${undoStack.length ? ` (${undoStack.length})` : ""}`, onClick: handleUndo },
            { label: `Redo${redoStack.length ? ` (${redoStack.length})` : ""}`, onClick: handleRedo },
            { divider: true },
            { label: "Find & Replace…", onClick: () => setShowFind(true) },
          ])}
          {renderMenu("view", "View", [
            { label: "Appearance / Theme…", onClick: () => setShowAppearance(true) },
            { label: "Writing Goal…", onClick: () => setShowGoalPanel(true) },
            { divider: true },
            { header: "Switch View" },
            { label: "Script View", checkbox: viewMode === "script", onClick: () => setViewMode("script") },
            { label: "Corkboard", checkbox: viewMode === "corkboard", onClick: () => setViewMode((v) => (v === "corkboard" ? "script" : "corkboard")) },
            { label: "Outline", checkbox: viewMode === "outline", onClick: () => setViewMode((v) => (v === "outline" ? "script" : "outline")) },
            { label: "Character Bible", checkbox: viewMode === "bible", onClick: () => setViewMode((v) => (v === "bible" ? "script" : "bible")) },
            { divider: true },
            { header: "View Aids" },
            { label: "Scene Numbers", checkbox: showSceneNumbers, onClick: () => setShowSceneNumbers((v) => !v) },
            { label: "Writing Nudges", checkbox: showWeakActionHints, onClick: () => setShowWeakActionHints((v) => !v) },
            { label: sceneListCollapsed ? "Show Scene List" : "Hide Scene List", checkbox: !sceneListCollapsed, onClick: () => setSceneListCollapsed((v) => !v) },
            { label: railCollapsed ? "Expand Left Panel" : "Collapse Left Panel", onClick: () => setRailCollapsed((v) => !v) },
            { divider: true },
            { label: "Zen Mode (Esc to exit)", onClick: () => setZenMode(true) },
            { divider: true },
            { label: isReading ? "Stop Reading" : "Table Read (from top)", onClick: isReading ? handleStopReading : () => handleTableRead(null) },
          ])}
          {renderMenu("reports", "Reports", [
            { label: "Scene Report", onClick: () => { setReportsTab("scenes"); setShowReportsPanel(true); } },
            { label: "Elements", onClick: () => { setReportsTab("elements"); setShowReportsPanel(true); } },
            { label: "Dialogue Statistics", onClick: () => { setReportsTab("dialogue"); setShowReportsPanel(true); } },
            { label: "Breakdown", onClick: () => { setReportsTab("breakdown"); setShowReportsPanel(true); } },
            { label: "Word Usage", onClick: () => { setReportsTab("usage"); setShowReportsPanel(true); } },
          ])}
          <input ref={fileInputRef} type="file" accept=".fountain,.txt,.fdx" style={{ display: "none" }} onChange={handleFile} />
          <button style={styles.btnPrimary} onClick={handleSave}>Save</button>
        </div>
      </div>
      )}

      {zenMode && (
        <button style={styles.zenExitBtn} className="no-print" onClick={() => setZenMode(false)}>
          ✕ Exit Zen (Esc)
        </button>
      )}

      {showFind && !zenMode && (
        <div style={styles.findBar} className="no-print">
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.shiftKey ? handleFindPrev() : handleFindNext();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setShowFind(false);
              }
            }}
            placeholder="Find"
            style={styles.findInput}
          />
          <span style={styles.findCount}>{matches.length ? `${matchIndex + 1} / ${matches.length}` : "0 / 0"}</span>
          <button style={styles.btn} onClick={handleFindPrev} disabled={matches.length === 0}>↑</button>
          <button style={styles.btn} onClick={handleFindNext} disabled={matches.length === 0}>↓</button>
          <input
            value={replaceQuery}
            onChange={(e) => setReplaceQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleReplaceOne();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setShowFind(false);
              }
            }}
            placeholder="Replace with"
            style={styles.findInput}
          />
          <button style={styles.btn} onClick={handleReplaceOne} disabled={matches.length === 0}>Replace</button>
          <button style={styles.btn} onClick={handleReplaceAll} disabled={matches.length === 0}>Replace All</button>
          <button style={styles.btn} onClick={() => setShowFind(false)}>✕</button>
        </div>
      )}

      <div style={styles.body}>
        {/* Left rail */}
        {viewMode === "script" && !zenMode && (
        <div style={{ ...styles.rail, ...(railCollapsed ? styles.railCollapsed : {}) }} className="no-print">
          <button
            style={styles.railToggle}
            onClick={() => setRailCollapsed((c) => !c)}
            title={railCollapsed ? "Expand panel" : "Collapse panel"}
          >
            {railCollapsed ? "»" : "« Collapse"}
          </button>

          {!railCollapsed && <div style={styles.railLabel}>Format</div>}

          {ORDER.map((t) => (
            <button
              key={t}
              onClick={() => setType(focusedId, t)}
              title={LABELS[t]}
              style={{
                ...styles.railBtn,
                ...(railCollapsed ? styles.railBtnCollapsed : {}),
                ...(focusedType === t ? styles.railBtnActive : {}),
              }}
            >
              {railCollapsed ? LABELS[t][0] : LABELS[t]}
            </button>
          ))}

          {!railCollapsed && focusedType === "character" && (
            <>
              <div style={{ ...styles.railLabel, marginTop: "14px" }}>Extension</div>
              {EXTENSIONS.map((ext) => {
                const focusedBlock = blocks.find((b) => b.id === focusedId);
                const match = focusedBlock?.text.match(/\(([^()]*)\)\s*$/);
                const active = match && match[1].trim().toUpperCase() === ext;
                return (
                  <button
                    key={ext}
                    onClick={() => toggleExtension(focusedId, ext)}
                    style={{
                      ...styles.railBtn,
                      fontSize: "11px",
                      ...(active ? styles.railBtnActive : {}),
                    }}
                  >
                    {ext}
                  </button>
                );
              })}
              <div style={{ ...styles.railLabel, marginTop: "14px" }}>Dual Dialogue</div>
              <button
                onClick={() => toggleDual(focusedId)}
                style={{
                  ...styles.railBtn,
                  fontSize: "11px",
                  ...(blocks.find((b) => b.id === focusedId)?.dual ? styles.railBtnActive : {}),
                }}
              >
                {blocks.find((b) => b.id === focusedId)?.dual ? "✓ Simultaneous (^)" : "Mark Simultaneous (^)"}
              </button>
            </>
          )}

          {!railCollapsed && focusedType === "action" && activeSelection?.blockId === focusedId && (
            <>
              <div style={{ ...styles.railLabel, marginTop: "14px" }}>Mark Selection</div>
              {Object.entries(CATEGORIES).map(([cat, label]) => (
                <button
                  key={cat}
                  onClick={() => markElement(activeSelection.blockId, activeSelection.start, activeSelection.end, cat)}
                  style={{ ...styles.railBtn, fontSize: "11px" }}
                >
                  {label}
                </button>
              ))}
            </>
          )}

          {!railCollapsed && (
            <div style={styles.railHint}>
              <div><b>Tab</b> — cycle format</div>
              <div><b>Shift+Tab</b> — cycle back</div>
              <div><b>Enter</b> — new element</div>
              <div><b>Shift+Enter</b> — line break</div>
              <div style={{ marginTop: "8px" }}>Select text in Action to mark a character/prop/sound cue.</div>
            </div>
          )}
        </div>
        )}

        {viewMode === "corkboard" ? (
          /* Corkboard / index card view — auto-derived from real scenes */
          <div style={styles.corkboardWrap} className="no-print">
            <div style={styles.corkboard}>
              {sceneUnits.map((u, i) => {
                if (u.headingId === null) {
                  if (u.blocks.length === 0) return null;
                  return (
                    <div key="leading" style={{ ...styles.card, ...styles.cardPinned }}>
                      <div style={styles.cardHeading}>Before first scene</div>
                    </div>
                  );
                }
                const reorderIdx = u.headingId === null ? -1 : sceneUnits.filter((x) => x.headingId !== null).findIndex((x) => x.headingId === u.headingId);
                const chars = getUnitCharacters(u.blocks);
                const preview = u.blocks.find((b) => b.type === "action" && b.text.trim())?.text.trim().slice(0, 90) || "";
                return (
                  <div
                    key={u.headingId}
                    draggable
                    onDragStart={(e) => handleCardDragStart(e, reorderIdx)}
                    onDragOver={handleCardDragOver}
                    onDrop={(e) => handleCardDrop(e, reorderIdx)}
                    onClick={() => handleCardClick(u.headingId)}
                    style={styles.card}
                  >
                    {showSceneNumbers && sceneNumberMap[u.headingId] && (
                      <div style={styles.cardNumber}>{sceneNumberMap[u.headingId]}</div>
                    )}
                    <div style={styles.cardHeading}>{u.heading}</div>
                    {preview && <div style={styles.cardPreview}>{preview}</div>}
                    <div style={styles.cardChars}>{chars.length ? chars.join(", ") : "No characters"}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : viewMode === "outline" ? (
          /* Step outline — free-form prose notes, independent of the
             actual script content and the corkboard's auto-derived cards. */
          <div style={styles.corkboardWrap} className="no-print">
            <div style={styles.outlineList}>
              <div style={{ display: "flex", gap: "8px", marginBottom: "10px", flexWrap: "wrap" }}>
                <button style={styles.btnPrimary} onClick={handleAddOutlineEntry}>+ Add Scene</button>
                <button style={styles.btn} onClick={handleExportOutline} disabled={stepOutline.length === 0}>Export Outline</button>
              </div>
              <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
                <span style={{ ...styles.railLabel, marginBottom: 0, alignSelf: "center" }}>Start from template:</span>
                {Object.entries(OUTLINE_TEMPLATES).map(([key, tmpl]) => (
                  <div key={key} style={{ position: "relative" }} className="template-tip-wrap">
                    <button style={{ ...styles.btn, fontSize: "11px" }} onClick={() => handleApplyOutlineTemplate(key)}>
                      {tmpl.name}
                    </button>
                    <div style={styles.templateTooltip} className="template-tip">
                      <div style={{ fontWeight: 700, marginBottom: "5px" }}>{tmpl.name}</div>
                      <div style={{ marginBottom: "7px" }}>{tmpl.description}</div>
                      <div style={{ color: mutedColor, fontSize: "10.5px" }}>e.g. {tmpl.examples.join(", ")}</div>
                    </div>
                  </div>
                ))}
              </div>
              {stepOutline.length === 0 && (
                <div style={{ color: mutedColor, fontSize: "13px" }}>No outline entries yet — add your first scene above, or start from a template.</div>
              )}
              {stepOutline.map((entry, idx) => (
                <div
                  key={entry.id}
                  style={styles.outlineEntry}
                  draggable
                  onDragStart={(e) => handleOutlineDragStart(e, idx)}
                  onDragOver={handleOutlineDragOver}
                  onDrop={(e) => handleOutlineDrop(e, idx)}
                >
                  <div style={styles.outlineEntryHeader}>
                    <span style={styles.outlineEntryNum}>{idx + 1}</span>
                    <input
                      style={styles.outlineHeadingInput}
                      value={entry.heading}
                      placeholder="Scene title / slug"
                      onChange={(e) => handleUpdateOutlineEntry(entry.id, "heading", e.target.value)}
                    />
                    <button style={styles.elementRemove} onClick={() => handleDeleteOutlineEntry(entry.id)} title="Delete">×</button>
                  </div>
                  <textarea
                    style={styles.outlineBodyInput}
                    value={entry.body}
                    placeholder="What happens in this scene…"
                    onChange={(e) => handleUpdateOutlineEntry(entry.id, "body", e.target.value)}
                    rows={3}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : viewMode === "bible" ? (
          /* Character bible — narrative notes per character, distinct
             from the Elements tracker (which is about capitalization). */
          <div style={styles.corkboardWrap} className="no-print">
            <div style={styles.outlineList}>
              <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
                <button style={styles.btnPrimary} onClick={() => handleAddBibleEntry()}>+ Add Character</button>
                <button style={styles.btn} onClick={handleExportCharacterBible} disabled={characterBible.length === 0}>
                  Export Bible
                </button>
              </div>
              {charactersNotInBible.length > 0 && (
                <div style={{ marginBottom: "16px" }}>
                  <div style={styles.railLabel}>Add From Script</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" }}>
                    {charactersNotInBible.map((name) => (
                      <button key={name} style={{ ...styles.railBtn, width: "auto", fontSize: "11px" }} onClick={() => handleAddBibleEntry(name)}>
                        + {name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {characterBible.length === 0 && (
                <div style={{ color: mutedColor, fontSize: "13px" }}>No characters yet — add one above.</div>
              )}
              {characterBible.map((entry, idx) => (
                <div
                  key={entry.id}
                  style={styles.outlineEntry}
                  draggable
                  onDragStart={(e) => handleBibleDragStart(e, idx)}
                  onDragOver={handleBibleDragOver}
                  onDrop={(e) => handleBibleDrop(e, idx)}
                >
                  <div style={styles.outlineEntryHeader}>
                    <input
                      style={styles.outlineHeadingInput}
                      value={entry.name}
                      placeholder="Character name"
                      onChange={(e) => handleUpdateBibleEntry(entry.id, "name", e.target.value)}
                    />
                    <input
                      style={{ ...styles.outlineHeadingInput, flex: "0 0 70px", fontWeight: 400 }}
                      value={entry.age}
                      placeholder="Age"
                      onChange={(e) => handleUpdateBibleEntry(entry.id, "age", e.target.value)}
                    />
                    <button style={styles.elementRemove} onClick={() => handleDeleteBibleEntry(entry.id)} title="Delete">×</button>
                  </div>
                  <textarea
                    style={styles.outlineBodyInput}
                    value={entry.description}
                    placeholder="Description — appearance, personality…"
                    onChange={(e) => handleUpdateBibleEntry(entry.id, "description", e.target.value)}
                    rows={2}
                  />
                  <div style={{ ...styles.railLabel, marginTop: "8px" }}>Arc / Notes</div>
                  <textarea
                    style={styles.outlineBodyInput}
                    value={entry.arc}
                    placeholder="Where they start, where they end up…"
                    onChange={(e) => handleUpdateBibleEntry(entry.id, "arc", e.target.value)}
                    rows={2}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
        /* Page */
        <div style={styles.pageWrap}>
          <div style={styles.page} className="print-page">
            {buildPageGroups(blocks).map((g, idx) => {
              const gap = idx === 0 ? 0 : "12pt";
              if (g.kind === "single") {
                return (
                  <div key={g.block.id} style={{ paddingTop: gap }}>
                    {renderField(g.block)}
                  </div>
                );
              }
              if (g.kind === "cue") {
                return (
                  <div key={g.character.id} style={{ paddingTop: gap }}>
                    {renderField(g.character)}
                    {g.body.map((bl) => renderField(bl))}
                  </div>
                );
              }
              return (
                <div key={g.left.character.id} style={{ ...styles.dualRow, paddingTop: gap }}>
                  <div style={styles.dualCol}>
                    {renderField(g.left.character, true)}
                    {g.left.body.map((bl) => renderField(bl, true))}
                  </div>
                  <div style={styles.dualCol}>
                    {renderField(g.right.character, true)}
                    {g.right.body.map((bl) => renderField(bl, true))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        )}

        {/* Right-side scene list */}
        {viewMode === "script" && !zenMode && (
          <div
            style={{
              ...styles.rail,
              ...(sceneListCollapsed ? styles.railCollapsed : {}),
              borderRight: "none",
              borderLeft: `1px solid ${lineColor}`,
            }}
            className="no-print"
          >
            <button
              style={styles.railToggle}
              onClick={() => setSceneListCollapsed((c) => !c)}
              title={sceneListCollapsed ? "Expand panel" : "Collapse panel"}
            >
              {sceneListCollapsed ? "«" : "Collapse »"}
            </button>
            {!sceneListCollapsed && <div style={styles.railLabel}>Scenes</div>}
            {blocks
              .filter((b) => b.type === "scene_heading")
              .map((b) => {
                const num = sceneNumberMap[b.id];
                const hasNote = !!(sceneNotes[b.id] && sceneNotes[b.id].trim());
                if (sceneListCollapsed) {
                  return (
                    <button
                      key={b.id}
                      onClick={() => setPendingFocus({ id: b.id, pos: "start" })}
                      title={b.text.trim() || "(untitled scene)"}
                      style={{ ...styles.railBtn, ...styles.railBtnCollapsed, whiteSpace: "nowrap" }}
                    >
                      {num || "•"}
                    </button>
                  );
                }
                return (
                  <div key={b.id} style={styles.sceneListRow}>
                    <button
                      onClick={() => setPendingFocus({ id: b.id, pos: "start" })}
                      title={b.text.trim() || "(untitled scene)"}
                      style={{ ...styles.railBtn, textAlign: "left", whiteSpace: "normal", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}
                    >
                      {`${num ? num + ". " : ""}${b.text.trim() || "(untitled)"}`}
                    </button>
                    <button
                      onClick={() => setShowSceneNoteFor(b.id)}
                      title={hasNote ? "Edit story note" : "Add story note"}
                      style={{ ...styles.sceneNoteIcon, ...(hasNote ? styles.sceneNoteIconActive : {}) }}
                    >
                      📝
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Status bar */}
      {!zenMode && (
      <div style={styles.statusBar} className="no-print">
        {viewMode === "corkboard" ? (
          <span style={styles.statusPill}>Corkboard</span>
        ) : viewMode === "outline" ? (
          <span style={styles.statusPill}>Outline</span>
        ) : viewMode === "bible" ? (
          <span style={styles.statusPill}>Character Bible</span>
        ) : (
          <span style={styles.statusPill}>{LABELS[focusedType]}</span>
        )}
        <span style={styles.statusText}>
          {viewMode === "corkboard"
            ? `${sceneUnits.filter((u) => u.headingId !== null).length} scenes · drag cards to reorder`
            : viewMode === "outline"
            ? `${stepOutline.length} outline entr${stepOutline.length === 1 ? "y" : "ies"} · drag to reorder`
            : viewMode === "bible"
            ? `${characterBible.length} character${characterBible.length === 1 ? "" : "s"} · drag to reorder`
            : `${wordCount} words · ~${pageEstimate} page${pageEstimate === 1 ? "" : "s"}`}
          {lastSaved ? ` · Saved ${new Date(lastSaved).toLocaleTimeString()}` : ""}
          {authed ? (appPassword ? " · Cloud sync on" : " · Local only") : ""}
          {` · ${wordsToday}/${dailyGoal} today${streak > 0 ? ` 🔥${streak}` : ""}`}
        </span>
      </div>
      )}

      {isReading && (
        <div style={styles.readingIndicator} className="no-print">
          <span>🔊 Reading…</span>
          <button style={styles.btn} onClick={handleStopReading}>Stop</button>
        </div>
      )}

      {/* Right-click mark menu */}
      {contextMenu && (
        <>
          <div style={styles.overlay} className="no-print" onClick={closeContextMenu} />
          <div style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y, maxHeight: "320px", overflowY: "auto" }} className="no-print">
            {wordAssocStage === null && (
              <>
                <button style={styles.contextMenuBtn} onClick={() => handleReadAloudSelection(contextMenu)}>
                  🔊 Read Aloud
                </button>
                <button
                  style={styles.contextMenuBtn}
                  onClick={() => {
                    handleTableRead(contextMenu.blockId);
                    closeContextMenu();
                  }}
                >
                  ▶ Table Read From Here
                </button>
                <button style={styles.contextMenuBtn} onClick={() => setWordAssocStage("relations")}>
                  📖 Word Association ›
                </button>
                {contextMenu.blockType === "action" && (
                  <>
                    <div style={styles.menuDivider} />
                    {Object.entries(CATEGORIES).map(([cat, label]) => (
                      <button
                        key={cat}
                        style={styles.contextMenuBtn}
                        onClick={() => markElement(contextMenu.blockId, contextMenu.start, contextMenu.end, cat)}
                      >
                        Mark as {label}
                      </button>
                    ))}
                  </>
                )}
              </>
            )}

            {wordAssocStage === "relations" && (
              <>
                <button style={styles.contextMenuBtn} onClick={() => setWordAssocStage(null)}>‹ Back</button>
                <div style={styles.menuDivider} />
                {WORD_ASSOC_RELATIONS.map((r) => (
                  <button key={r.code} style={styles.contextMenuBtn} onClick={() => handleWordAssocRelation(r.code, r.label)}>
                    {r.label}
                  </button>
                ))}
              </>
            )}

            {wordAssocStage === "results" && (
              <>
                <button style={styles.contextMenuBtn} onClick={() => setWordAssocStage("relations")}>‹ Back</button>
                <div style={styles.menuDivider} />
                <div style={styles.menuSectionLabel}>{wordAssocRelation}</div>
                {wordAssocLoading && (
                  <div style={{ padding: "8px 10px", fontSize: "12px", color: mutedColor }}>Loading…</div>
                )}
                {!wordAssocLoading && wordAssocError && (
                  <div style={{ padding: "8px 10px", fontSize: "12px", color: mutedColor }}>{wordAssocError}</div>
                )}
                {!wordAssocLoading &&
                  wordAssocResults.map((w) => (
                    <button key={w} style={styles.contextMenuBtn} onClick={() => handleApplyWordAssoc(w)}>
                      {w}
                    </button>
                  ))}
              </>
            )}
          </div>
        </>
      )}

      {/* Reports panel — Scenes / Elements / Dialogue */}
      {showReportsPanel && (
        <>
          <div style={styles.overlay} className="no-print" onClick={() => setShowReportsPanel(false)} />
          <div style={styles.panel} className="no-print">
            <div style={styles.panelHeader}>
              <span style={styles.brandText}>REPORTS</span>
              <button style={styles.btn} onClick={() => setShowReportsPanel(false)}>Close</button>
            </div>

            <div style={styles.tabRow}>
              <button
                style={{ ...styles.tabBtn, ...(reportsTab === "scenes" ? styles.tabBtnActive : {}) }}
                onClick={() => setReportsTab("scenes")}
              >
                Scenes
              </button>
              <button
                style={{ ...styles.tabBtn, ...(reportsTab === "elements" ? styles.tabBtnActive : {}) }}
                onClick={() => setReportsTab("elements")}
              >
                Elements{elements.length > 0 ? ` (${elements.length})` : ""}
              </button>
              <button
                style={{ ...styles.tabBtn, ...(reportsTab === "dialogue" ? styles.tabBtnActive : {}) }}
                onClick={() => setReportsTab("dialogue")}
              >
                Dialogue
              </button>
              <button
                style={{ ...styles.tabBtn, ...(reportsTab === "breakdown" ? styles.tabBtnActive : {}) }}
                onClick={() => setReportsTab("breakdown")}
              >
                Breakdown
              </button>
              <button
                style={{ ...styles.tabBtn, ...(reportsTab === "usage" ? styles.tabBtnActive : {}) }}
                onClick={() => setReportsTab("usage")}
              >
                Word Usage
              </button>
            </div>

            {reportsTab === "scenes" && (
              <>
                <button style={{ ...styles.btnPrimary, width: "100%", marginBottom: "16px" }} onClick={handleExportScriptReport}>
                  Export Report
                </button>
                <div style={{ fontSize: "12px", color: mutedColor, marginBottom: "14px" }}>
                  {scenes.length} scene{scenes.length === 1 ? "" : "s"} · {new Set(scenes.flatMap((s) => s.characters)).size} character
                  {new Set(scenes.flatMap((s) => s.characters)).size === 1 ? "" : "s"}
                </div>
                {scenes.map((s, i) => (
                  <div key={i} style={styles.sceneCard}>
                    <div style={{ fontWeight: 700, fontSize: "12.5px" }}>{i + 1}. {s.heading}</div>
                    <div style={{ fontSize: "11.5px", color: mutedColor, marginTop: "4px" }}>
                      {s.characters.length ? s.characters.join(", ") : "No characters"} · ~{s.pages}p
                    </div>
                  </div>
                ))}
                {nameWarnings.length > 0 && (
                  <div style={{ marginTop: "18px" }}>
                    <div style={styles.railLabel}>Possible Name Inconsistencies</div>
                    {nameWarnings.map(([a, b], i) => (
                      <div key={i} style={styles.warningRow}>"{a}" vs "{b}"</div>
                    ))}
                  </div>
                )}
              </>
            )}

            {reportsTab === "elements" && (
              <>
                <button style={{ ...styles.btnPrimary, width: "100%", marginBottom: "8px" }} onClick={handleExportElements}>
                  Export Report
                </button>
                <button style={{ ...styles.btn, width: "100%", marginBottom: "16px" }} onClick={handleLoadElementsClick}>
                  Load Report
                </button>
                <input
                  ref={elementsFileInputRef}
                  type="file"
                  accept=".md,.txt"
                  style={{ display: "none" }}
                  onChange={handleElementsFile}
                />
                {elements.length === 0 && <div style={{ color: mutedColor, fontSize: "13px" }}>Nothing marked yet. Select text in an Action line to tag a character, prop, or sound cue.</div>}
                {Object.entries(CATEGORIES).map(([cat, label]) => {
                  const items = elements.filter((e) => e.category === cat);
                  if (items.length === 0) return null;
                  return (
                    <div key={cat} style={{ marginBottom: "18px" }}>
                      <div style={styles.railLabel}>{label}</div>
                      {items.map((it) => (
                        <div key={it.id} style={styles.elementRow}>
                          <span>{it.text}</span>
                          <button style={styles.elementRemove} onClick={() => removeElement(it.id)}>×</button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            )}

            {reportsTab === "dialogue" && (
              <>
                <button style={{ ...styles.btnPrimary, width: "100%", marginBottom: "16px" }} onClick={handleExportDialogueStats}>
                  Export Report
                </button>
                {dialogueStats.length === 0 && (
                  <div style={{ color: mutedColor, fontSize: "13px" }}>No dialogue yet.</div>
                )}
                {dialogueStats.map((s) => (
                  <div key={s.name} style={styles.statRow}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                      <span>{s.name}</span>
                      <span style={{ color: mutedColor }}>{s.words}w · {s.pct}%</span>
                    </div>
                    <div style={styles.statBarTrack}>
                      <div style={{ ...styles.statBarFill, width: `${s.pct}%` }} />
                    </div>
                  </div>
                ))}
              </>
            )}

            {reportsTab === "breakdown" && (
              <>
                <button style={{ ...styles.btnPrimary, width: "100%", marginBottom: "16px" }} onClick={handleExportBreakdown}>
                  Export Report
                </button>

                <div style={styles.railLabel}>Locations</div>
                {breakdown.locations.length === 0 && <div style={{ color: mutedColor, fontSize: "12px", marginBottom: "14px" }}>No scenes yet.</div>}
                {breakdown.locations.map(([loc, n]) => (
                  <div key={loc} style={styles.elementRow}>
                    <span>{loc}</span>
                    <span style={{ color: mutedColor }}>{n}</span>
                  </div>
                ))}

                <div style={{ ...styles.railLabel, marginTop: "18px" }}>Day / Night</div>
                {breakdown.dayNight.map(([k, n]) => (
                  <div key={k} style={styles.elementRow}>
                    <span>{k}</span>
                    <span style={{ color: mutedColor }}>{n}</span>
                  </div>
                ))}

                <div style={{ ...styles.railLabel, marginTop: "18px" }}>Interior / Exterior</div>
                {breakdown.intExt.map(([k, n]) => (
                  <div key={k} style={styles.elementRow}>
                    <span>{k}</span>
                    <span style={{ color: mutedColor }}>{n}</span>
                  </div>
                ))}

                <div style={{ ...styles.railLabel, marginTop: "18px" }}>Characters by Scene Count</div>
                {breakdown.characterScenes.map(([name, n]) => (
                  <div key={name} style={styles.elementRow}>
                    <span>{name}</span>
                    <span style={{ color: mutedColor }}>{n}</span>
                  </div>
                ))}
              </>
            )}

            {reportsTab === "usage" && (
              <>
                <button style={{ ...styles.btnPrimary, width: "100%", marginBottom: "16px" }} onClick={handleExportCrutchWords} disabled={crutchWords.length === 0}>
                  Export Report
                </button>
                <div style={{ fontSize: "12px", color: mutedColor, marginBottom: "10px" }}>
                  Words repeated 3+ times in Action/Dialogue (common words and character names excluded).
                </div>
                {crutchWords.length === 0 && <div style={{ color: mutedColor, fontSize: "13px" }}>Nothing notably repeated yet.</div>}
                {crutchWords.map(([word, n]) => (
                  <div key={word} style={styles.elementRow}>
                    <span>{word}</span>
                    <span style={{ color: mutedColor }}>{n}×</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {/* Writing Goal panel */}
      {showGoalPanel && (
        <>
          <div style={styles.overlay} className="no-print" onClick={() => setShowGoalPanel(false)} />
          <div style={styles.panel} className="no-print">
            <div style={styles.panelHeader}>
              <span style={styles.brandText}>WRITING GOAL</span>
              <button style={styles.btn} onClick={() => setShowGoalPanel(false)}>Close</button>
            </div>

            <div style={styles.fieldLabel}>Daily Word Goal</div>
            <input
              type="number"
              min="0"
              style={styles.authInput}
              value={dailyGoal}
              onChange={(e) => setDailyGoal(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />

            <div style={{ fontSize: "13px", marginBottom: "6px" }}>
              {wordsToday} / {dailyGoal} words today
            </div>
            <div style={styles.statBarTrack}>
              <div style={{ ...styles.statBarFill, width: `${dailyGoal > 0 ? Math.min(100, (wordsToday / dailyGoal) * 100) : 0}%` }} />
            </div>

            <div style={{ marginTop: "18px", fontSize: "13px", color: mutedColor }}>
              {streak > 0 ? `🔥 ${streak} day streak` : "No active streak yet — hit your goal today to start one."}
            </div>
          </div>
        </>
      )}

      {/* Scene Note panel */}
      {showSceneNoteFor && (
        <>
          <div style={styles.overlay} className="no-print" onClick={() => setShowSceneNoteFor(null)} />
          <div style={styles.panel} className="no-print">
            <div style={styles.panelHeader}>
              <span style={styles.brandText}>SCENE NOTE</span>
              <button style={styles.btn} onClick={() => setShowSceneNoteFor(null)}>Close</button>
            </div>
            <div style={{ fontSize: "12.5px", color: mutedColor, marginBottom: "10px" }}>
              {blocks.find((b) => b.id === showSceneNoteFor)?.text.trim() || "(untitled scene)"}
            </div>
            <div style={styles.fieldLabel}>What does the protagonist want here? What's in their way?</div>
            <textarea
              autoFocus
              style={{ ...styles.authInput, minHeight: "140px", resize: "vertical", fontFamily: "inherit" }}
              value={sceneNotes[showSceneNoteFor] || ""}
              onChange={(e) => handleUpdateSceneNote(showSceneNoteFor, e.target.value)}
              placeholder="Private notes — not printed, not part of the script…"
            />
          </div>
        </>
      )}

      {/* Title Page panel */}
      {showTitlePage && (
        <>
          <div style={styles.overlay} className="no-print" onClick={() => setShowTitlePage(false)} />
          <div style={styles.panel} className="no-print">
            <div style={styles.panelHeader}>
              <span style={styles.brandText}>TITLE PAGE</span>
              <button style={styles.btn} onClick={() => setShowTitlePage(false)}>Close</button>
            </div>

            <div style={styles.fieldLabel}>Title</div>
            <input style={styles.authInput} value={title} onChange={(e) => setTitle(e.target.value)} />

            <div style={styles.fieldLabel}>Credit (byline)</div>
            <input style={styles.authInput} value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="Written by" />

            <div style={styles.fieldLabel}>Author</div>
            <input style={styles.authInput} value={author} onChange={(e) => setAuthor(e.target.value)} />

            <div style={styles.fieldLabel}>Based On</div>
            <input style={styles.authInput} value={basedOn} onChange={(e) => setBasedOn(e.target.value)} placeholder="Based on the novel by…" />

            <div style={styles.fieldLabel}>Draft / Date</div>
            <input style={styles.authInput} value={draftDate} onChange={(e) => setDraftDate(e.target.value)} placeholder="1st Draft — March 2026" />

            <div style={styles.fieldLabel}>Contact</div>
            <textarea
              style={{ ...styles.authInput, minHeight: "70px", resize: "vertical", fontFamily: "inherit" }}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={"Name\nPhone\nEmail"}
            />
          </div>
        </>
      )}

      {/* Appearance panel */}
      {showAppearance && (
        <>
          <div style={styles.overlay} className="no-print" onClick={() => setShowAppearance(false)} />
          <div style={styles.panel} className="no-print">
            <div style={styles.panelHeader}>
              <span style={styles.brandText}>APPEARANCE</span>
              <button style={styles.btn} onClick={() => setShowAppearance(false)}>Close</button>
            </div>

            <div style={styles.railLabel}>Presets</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "20px" }}>
              {THEMES.map((p) => {
                const active = theme.ink === p.ink && theme.gold === p.gold && theme.paper === p.paper;
                return (
                  <button
                    key={p.id}
                    title={p.name}
                    onClick={() => setTheme({ ink: p.ink, paper: p.paper, text: p.text, gold: p.gold })}
                    style={{
                      ...styles.swatch,
                      border: active ? `2px solid ${theme.gold}` : "2px solid transparent",
                      background: `linear-gradient(135deg, ${p.ink} 50%, ${p.gold} 50%)`,
                    }}
                  />
                );
              })}
            </div>

            <div style={styles.railLabel}>Custom</div>
            <label style={styles.colorRow}>
              <span>Background</span>
              <input
                type="color"
                value={theme.ink}
                onChange={(e) => {
                  const hex = e.target.value;
                  setTheme((t) => ({ ...t, ink: hex, text: autoText(hex) }));
                }}
              />
            </label>
            <label style={styles.colorRow}>
              <span>Accent</span>
              <input type="color" value={theme.gold} onChange={(e) => setTheme((t) => ({ ...t, gold: e.target.value }))} />
            </label>
            <label style={styles.colorRow}>
              <span>Page</span>
              <input type="color" value={theme.paper} onChange={(e) => setTheme((t) => ({ ...t, paper: e.target.value }))} />
            </label>

            <button style={{ ...styles.btn, width: "100%", marginTop: "18px" }} onClick={() => setTheme(DEFAULT_THEME)}>
              Reset to Default
            </button>
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Themes — small color helpers + presets. Each theme supplies an
   "ink" (app background), "paper" (page background), "text" (chrome
   text color), and "gold" (accent). "mute"/"line" are derived from
   ink+text so any custom combination stays readable.
--------------------------------------------------------------- */
function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}
function mix(hex1, hex2, weight) {
  const c1 = hexToRgb(hex1), c2 = hexToRgb(hex2);
  return rgbToHex(c1.map((v, i) => v + (c2[i] - v) * weight));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function autoText(inkHex) {
  return luminance(inkHex) > 0.5 ? "#241f18" : "#fbf9f4";
}

const THEMES = [
  { id: "classic", name: "Classic Ink & Gold", ink: "#1b1a17", paper: "#fbf9f4", text: "#fbf9f4", gold: "#c9a24c" },
  { id: "midnight", name: "Midnight Blue", ink: "#111827", paper: "#f7f8fa", text: "#e7ecf5", gold: "#7ea6d8" },
  { id: "noir", name: "Noir", ink: "#121212", paper: "#fafafa", text: "#eeeeee", gold: "#c9c9c9" },
  { id: "crimson", name: "Crimson Draft", ink: "#241012", paper: "#fbf5f4", text: "#f3e3e1", gold: "#c8555f" },
  { id: "forest", name: "Forest", ink: "#0f1f17", paper: "#f6faf6", text: "#e3eee4", gold: "#82b384" },
  { id: "amber", name: "Amber Terminal", ink: "#0d0f0a", paper: "#f7f3e8", text: "#e8dcc0", gold: "#ffb020" },
  { id: "violet", name: "Deep Purple", ink: "#1a1025", paper: "#f8f5fc", text: "#e5daf0", gold: "#a78bfa" },
  { id: "ocean", name: "Ocean", ink: "#0a1f2e", paper: "#f4fafc", text: "#d5eef0", gold: "#4fd1c5" },
  { id: "steel", name: "Charcoal Steel", ink: "#1e1e1e", paper: "#fafafa", text: "#e8e8e8", gold: "#8fa8c4" },
  { id: "studio", name: "Light Studio", ink: "#f2efe7", paper: "#ffffff", text: "#2a251d", gold: "#b5651d" },
  { id: "paperwhite", name: "Paper White", ink: "#ffffff", paper: "#fdfdfd", text: "#232323", gold: "#3b6ea5" },
  { id: "sepia", name: "Sepia", ink: "#f4ecd8", paper: "#fffdf6", text: "#3b2f1e", gold: "#8a6d3b" },
  { id: "slate", name: "Slate Light", ink: "#eef1f4", paper: "#ffffff", text: "#1f2937", gold: "#2f6fed" },
  { id: "rosequartz", name: "Rose Quartz", ink: "#faf0f2", paper: "#fffbfc", text: "#3a2027", gold: "#c0607a" },
  { id: "mint", name: "Mint", ink: "#eefaf3", paper: "#ffffff", text: "#123324", gold: "#2f9e6a" },
  { id: "sand", name: "Sand", ink: "#f0e6d6", paper: "#fffbf5", text: "#3a2d1c", gold: "#c17a3f" },
  { id: "lavender", name: "Lavender", ink: "#f5f0fa", paper: "#ffffff", text: "#2e2438", gold: "#8b6dc4" },
];

const DEFAULT_THEME = THEMES[0];
const THEME_STORAGE_KEY = "slugline_theme_v1";
const PREFS_STORAGE_KEY = "slugline_prefs_v1";
const GOAL_STORAGE_KEY = "slugline_goal_v1";

function buildStyles(t) {
  const mute = mix(t.ink, t.text, 0.55);
  const line = mix(t.ink, t.text, 0.14);
  return {
    app: {
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      background: t.ink,
      color: t.text,
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
    },
    header: {
      display: "flex",
      alignItems: "center",
      gap: "16px",
      padding: "10px 18px",
      borderBottom: `1px solid ${line}`,
      flexWrap: "wrap",
    },
    brand: { display: "flex", alignItems: "center", gap: "8px", minWidth: "120px" },
    brandMark: { color: t.gold, fontSize: "18px" },
    brandText: { fontSize: "13px", letterSpacing: "3px", fontWeight: 700, color: t.gold },
    titleFields: { display: "flex", gap: "8px", flex: 1, minWidth: "240px" },
    titleInput: {
      background: "transparent",
      border: "none",
      borderBottom: `1px solid ${line}`,
      color: t.text,
      fontSize: "14px",
      padding: "4px 2px",
      flex: 2,
      minWidth: "120px",
      outline: "none",
    },
    authorInput: {
      background: "transparent",
      border: "none",
      borderBottom: `1px solid ${line}`,
      color: mute,
      fontSize: "13px",
      padding: "4px 2px",
      flex: 1,
      minWidth: "100px",
      outline: "none",
    },
    headerActions: { display: "flex", gap: "8px" },
    btn: {
      background: "transparent",
      color: t.text,
      border: `1px solid ${line}`,
      borderRadius: "3px",
      padding: "7px 12px",
      fontSize: "12px",
      cursor: "pointer",
      letterSpacing: "0.5px",
    },
    btnPrimary: {
      background: t.gold,
      color: t.ink,
      border: `1px solid ${t.gold}`,
      borderRadius: "3px",
      padding: "7px 14px",
      fontSize: "12px",
      fontWeight: 700,
      cursor: "pointer",
      letterSpacing: "0.5px",
    },
    body: { flex: 1, display: "flex", overflow: "hidden" },
    rail: {
      width: "150px",
      borderRight: `1px solid ${line}`,
      padding: "16px 8px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      overflowY: "auto",
      overflowX: "hidden",
      flexShrink: 0,
      transition: "width 0.15s ease",
    },
    railCollapsed: { width: "44px", padding: "16px 5px", alignItems: "center" },
    railToggle: {
      background: "transparent",
      border: `1px solid ${line}`,
      color: mute,
      borderRadius: "3px",
      padding: "6px 8px",
      fontSize: "11px",
      cursor: "pointer",
      marginBottom: "8px",
      width: "100%",
    },
    railLabel: { fontSize: "10px", letterSpacing: "2px", color: mute, marginBottom: "4px", paddingLeft: "4px" },
    railBtn: {
      background: "transparent",
      border: `1px solid ${line}`,
      color: t.text,
      borderRadius: "3px",
      padding: "8px 10px",
      fontSize: "12px",
      textAlign: "left",
      cursor: "pointer",
      width: "100%",
    },
    railBtnCollapsed: { textAlign: "center", padding: "8px 0", fontWeight: 700 },
    railBtnActive: { background: t.gold, color: t.ink, border: `1px solid ${t.gold}`, fontWeight: 700 },
    railHint: { marginTop: "18px", fontSize: "10.5px", color: mute, lineHeight: 1.8, paddingLeft: "4px" },
    pageWrap: { flex: 1, overflowY: "auto", padding: "24px 8px", display: "flex", justifyContent: "center" },
    page: {
      background: t.paper,
      color: "#1a1a1a",
      width: "8.5in",
      minHeight: "11in",
      padding: "1in 1in 1in 1.5in",
      boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
      flexShrink: 0,
    },
    line: {
      display: "block",
      width: "100%",
      background: "transparent",
      border: "none",
      outline: "none",
      resize: "none",
      overflow: "hidden",
      fontFamily: "'Courier Prime', 'Courier New', Courier, monospace",
      fontSize: "12pt",
      lineHeight: 1,
      color: "#1a1a1a",
      padding: 0,
      margin: 0,
    },
    statusBar: {
      display: "flex",
      justifyContent: "space-between",
      padding: "6px 18px",
      borderTop: `1px solid ${line}`,
      fontSize: "11.5px",
      color: mute,
    },
    statusPill: {
      background: `${t.gold}26`,
      color: t.gold,
      border: `1px solid ${t.gold}`,
      borderRadius: "3px",
      padding: "2px 8px",
      fontWeight: 700,
      letterSpacing: "0.5px",
      fontSize: "10.5px",
    },
    statusText: {},
    overlay: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.35)",
      zIndex: 40,
    },
    contextMenu: {
      position: "fixed",
      zIndex: 50,
      background: t.ink,
      border: `1px solid ${t.gold}`,
      borderRadius: "4px",
      padding: "6px",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
      minWidth: "160px",
    },
    contextMenuBtn: {
      background: "transparent",
      border: "none",
      color: t.text,
      textAlign: "left",
      padding: "8px 10px",
      fontSize: "12.5px",
      cursor: "pointer",
      borderRadius: "3px",
    },
    panel: {
      position: "fixed",
      top: 0,
      right: 0,
      bottom: 0,
      width: "320px",
      maxWidth: "90vw",
      background: t.ink,
      borderLeft: `1px solid ${line}`,
      padding: "18px",
      overflowY: "auto",
      zIndex: 50,
      boxShadow: "-8px 0 30px rgba(0,0,0,0.5)",
    },
    panelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" },
    elementRow: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "6px 8px",
      fontSize: "12.5px",
      borderBottom: `1px solid ${line}`,
    },
    elementRemove: {
      background: "transparent",
      border: "none",
      color: mute,
      cursor: "pointer",
      fontSize: "15px",
      lineHeight: 1,
      padding: "0 4px",
    },
    dualRow: { display: "flex", gap: "0.3in", width: "100%" },
    dualCol: { flex: 1, minWidth: 0 },
    suggestDropdown: {
      position: "absolute",
      zIndex: 30,
      background: t.ink,
      border: `1px solid ${t.gold}`,
      borderRadius: "3px",
      marginTop: "2px",
      overflow: "hidden",
      boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
    },
    suggestItem: {
      padding: "6px 10px",
      fontSize: "11.5px",
      fontFamily: "'Courier Prime', 'Courier New', Courier, monospace",
      color: t.text,
      cursor: "pointer",
      whiteSpace: "nowrap",
    },
    suggestItemActive: { background: t.gold, color: t.ink },
    sceneCard: {
      padding: "8px",
      border: `1px solid ${line}`,
      borderRadius: "3px",
      marginBottom: "8px",
    },
    warningRow: {
      fontSize: "12px",
      color: t.gold,
      padding: "4px 0",
      borderBottom: `1px solid ${line}`,
    },
    swatch: {
      width: "44px",
      height: "44px",
      borderRadius: "6px",
      cursor: "pointer",
      padding: 0,
    },
    colorRow: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      fontSize: "12.5px",
      padding: "4px 0",
    },
    menuOverlay: {
      position: "fixed",
      inset: 0,
      background: "transparent",
      zIndex: 55,
    },
    dropdownMenu: {
      position: "absolute",
      top: "100%",
      left: 0,
      marginTop: "4px",
      background: t.ink,
      border: `1px solid ${line}`,
      borderRadius: "4px",
      minWidth: "210px",
      zIndex: 60,
      boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
      padding: "4px",
      display: "flex",
      flexDirection: "column",
    },
    dropdownItem: {
      background: "transparent",
      border: "none",
      color: t.text,
      textAlign: "left",
      padding: "8px 10px",
      fontSize: "12.5px",
      cursor: "pointer",
      borderRadius: "3px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      width: "100%",
    },
    menuDivider: { height: "1px", background: line, margin: "4px 2px" },
    menuSectionLabel: {
      fontSize: "10px",
      letterSpacing: "1px",
      textTransform: "uppercase",
      color: mute,
      padding: "8px 10px 2px",
    },
    checkbox: { width: "14px", display: "inline-block", color: t.gold, fontWeight: 700 },
    tabRow: {
      display: "flex",
      gap: "6px",
      marginBottom: "16px",
      borderBottom: `1px solid ${line}`,
      paddingBottom: "8px",
    },
    tabBtn: {
      background: "transparent",
      border: "none",
      color: mute,
      fontSize: "11px",
      letterSpacing: "1px",
      padding: "6px 8px",
      cursor: "pointer",
      borderRadius: "3px",
      textTransform: "uppercase",
    },
    tabBtnActive: { color: t.gold, background: `${t.gold}1a`, fontWeight: 700 },
    corkboardWrap: { flex: 1, overflowY: "auto", padding: "28px" },
    corkboard: { display: "flex", flexWrap: "wrap", gap: "16px", alignContent: "flex-start" },
    card: {
      width: "220px",
      minHeight: "130px",
      background: t.paper,
      color: "#1a1a1a",
      borderRadius: "3px",
      padding: "12px",
      boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
      cursor: "grab",
      fontFamily: "'Courier Prime', 'Courier New', Courier, monospace",
      position: "relative",
    },
    cardPinned: { cursor: "default", opacity: 0.7 },
    cardNumber: {
      position: "absolute",
      top: "8px",
      right: "10px",
      fontSize: "10px",
      color: "#8a8578",
      fontWeight: 700,
    },
    cardHeading: { fontWeight: 700, fontSize: "11.5px", marginBottom: "8px", paddingRight: "18px" },
    cardPreview: { fontSize: "10.5px", color: "#4a4a4a", marginBottom: "8px", lineHeight: 1.4 },
    cardChars: { fontSize: "10px", color: "#8a8578", marginTop: "auto" },
    outlineList: { maxWidth: "700px", margin: "0 auto" },
    outlineEntry: {
      background: mix(t.ink, t.text, 0.06),
      border: `1px solid ${line}`,
      borderRadius: "5px",
      padding: "12px",
      marginBottom: "12px",
      cursor: "grab",
    },
    outlineEntryHeader: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" },
    outlineEntryNum: { fontSize: "12px", color: t.gold, fontWeight: 700, minWidth: "20px" },
    outlineHeadingInput: {
      flex: 1,
      background: "transparent",
      border: "none",
      borderBottom: `1px solid ${line}`,
      color: t.text,
      fontSize: "13px",
      fontWeight: 700,
      padding: "4px 2px",
      outline: "none",
    },
    outlineBodyInput: {
      width: "100%",
      background: "transparent",
      border: "none",
      color: t.text,
      fontSize: "13px",
      lineHeight: 1.5,
      outline: "none",
      resize: "vertical",
      fontFamily: "inherit",
    },
    readingIndicator: {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: 70,
      display: "flex",
      alignItems: "center",
      gap: "10px",
      background: t.ink,
      border: `1px solid ${t.gold}`,
      borderRadius: "20px",
      padding: "8px 14px",
      fontSize: "12.5px",
      color: t.text,
      boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
    },
    statRow: { marginBottom: "12px" },
    statBarTrack: { height: "6px", background: line, borderRadius: "3px", marginTop: "4px", overflow: "hidden" },
    statBarFill: { height: "100%", background: t.gold },
    sceneNumberBadge: {
      position: "absolute",
      top: 0,
      fontFamily: "'Courier Prime', 'Courier New', Courier, monospace",
      fontSize: "12pt",
      lineHeight: 1,
      color: "#1a1a1a",
    },
    todWarning: {
      position: "absolute",
      top: "2px",
      right: "2px",
      fontSize: "10px",
      color: "#c9812f",
      fontWeight: 700,
      cursor: "help",
      background: "rgba(255,255,255,0.85)",
      padding: "0 3px",
      borderRadius: "2px",
    },
    weakActionBadge: {
      position: "absolute",
      top: "2px",
      right: "2px",
      fontSize: "10px",
      color: "#8a6dc4",
      fontWeight: 700,
      cursor: "help",
      background: "rgba(255,255,255,0.85)",
      padding: "0 3px",
      borderRadius: "2px",
    },
    sceneListRow: { display: "flex", alignItems: "center", gap: "2px" },
    sceneNoteIcon: {
      background: "transparent",
      border: "none",
      cursor: "pointer",
      fontSize: "12px",
      opacity: 0.35,
      padding: "4px",
      flexShrink: 0,
    },
    sceneNoteIconActive: { opacity: 1 },
    zenExitBtn: {
      position: "fixed",
      top: "14px",
      right: "14px",
      zIndex: 70,
      background: t.ink,
      color: t.text,
      border: `1px solid ${t.gold}`,
      borderRadius: "20px",
      padding: "6px 14px",
      fontSize: "11.5px",
      cursor: "pointer",
      boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
    },
    templateTooltip: {
      display: "none",
      position: "absolute",
      top: "100%",
      left: 0,
      marginTop: "6px",
      width: "220px",
      background: t.ink,
      border: `1px solid ${t.gold}`,
      borderRadius: "5px",
      padding: "10px",
      fontSize: "11.5px",
      color: t.text,
      zIndex: 80,
      boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
      lineHeight: 1.4,
    },
    authWrap: {
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
    },
    authCard: {
      width: "300px",
      maxWidth: "90vw",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      background: mix(t.ink, t.text, 0.06),
      border: `1px solid ${line}`,
      borderRadius: "6px",
      padding: "28px 24px",
    },
    authHint: { fontSize: "12.5px", color: mute, margin: "4px 0 6px" },
    authInput: {
      background: "transparent",
      border: `1px solid ${line}`,
      borderRadius: "3px",
      color: t.text,
      padding: "9px 10px",
      fontSize: "13px",
      outline: "none",
      width: "100%",
      marginBottom: "14px",
    },
    fieldLabel: { fontSize: "11px", letterSpacing: "1px", color: mute, marginBottom: "6px", textTransform: "uppercase" },
    authError: { fontSize: "12px", color: "#e08080" },
    authSkip: {
      background: "transparent",
      border: "none",
      color: mute,
      fontSize: "11.5px",
      textDecoration: "underline",
      cursor: "pointer",
      padding: "4px 0",
    },
    pickerCard: {
      width: "380px",
      maxWidth: "92vw",
      background: mix(t.ink, t.text, 0.06),
      border: `1px solid ${line}`,
      borderRadius: "6px",
      padding: "22px",
    },
    scriptRow: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "14px",
      marginBottom: "10px",
      borderRadius: "6px",
      border: `1px solid ${line}`,
      background: mix(t.ink, t.text, 0.05),
      cursor: "pointer",
      transition: "background 0.12s ease, border-color 0.12s ease",
    },
    findBar: {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "8px 18px",
      borderBottom: `1px solid ${line}`,
      flexWrap: "wrap",
    },
    findInput: {
      background: "transparent",
      border: `1px solid ${line}`,
      borderRadius: "3px",
      color: t.text,
      padding: "6px 8px",
      fontSize: "12.5px",
      outline: "none",
      minWidth: "140px",
    },
    findCount: { fontSize: "11px", color: mute, minWidth: "48px", textAlign: "center" },
  };
}

function buildGlobalCss(t) {
  const line = mix(t.ink, t.text, 0.14);
  return `
  @import url('https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap');
  * { box-sizing: border-box; }
  textarea::placeholder { color: #b9b3a0; }
  textarea:focus { background: rgba(0,0,0,0.035); box-shadow: inset 3px 0 0 ${t.gold}; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: ${t.ink}; }
  ::-webkit-scrollbar-thumb { background: ${line}; border-radius: 5px; }
  input[type="color"] { width: 36px; height: 26px; border: none; border-radius: 4px; padding: 0; background: transparent; cursor: pointer; }
  .script-row:hover { background: ${mix(t.ink, t.text, 0.11)} !important; border-color: ${t.gold} !important; }
  .template-tip-wrap:hover .template-tip { display: block !important; }
  @media print {
    .no-print { display: none !important; }
    body, html { background: white !important; }
    .print-page { box-shadow: none !important; margin: 0 !important; }
    .scene-heading-field { color: #1a1a1a !important; background: transparent !important; }
  }
`;
}
