import React, { useState, useRef, useEffect, useCallback } from "react";

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
   Fountain export
--------------------------------------------------------------- */
function generateFountain(blocks, title, author) {
  const out = [];
  if (title.trim() || author.trim()) {
    if (title.trim()) out.push(`Title: ${title.trim()}`);
    if (author.trim()) out.push(`Author: ${author.trim()}`);
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
  const titleRe = /^([A-Za-z ]+):\s*(.*)$/;
  while (i < lines.length && lines[i].trim() !== "" && titleRe.test(lines[i])) {
    const m = lines[i].match(titleRe);
    const key = m[1].trim().toLowerCase();
    if (key === "title") ttl = m[2].trim();
    if (["author", "authors", "writer", "written by"].includes(key)) auth = m[2].trim();
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;

  const blocksOut = [];
  const push = (type, text) => blocksOut.push({ id: newId(), type, text });
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
    } else {
      push(type, content);
    }
    lastNonBlankType = type;
    lastBlank = false;
  }
  if (blocksOut.length === 0) push("scene_heading", "");
  return { title: ttl, author: auth, blocks: blocksOut };
}

/* ---------------------------------------------------------------
   Component
--------------------------------------------------------------- */
export default function ScreenplayEditor() {
  const [title, setTitle] = useState("Untitled Screenplay");
  const [author, setAuthor] = useState("");
  const [blocks, setBlocks] = useState([{ id: newId(), type: "scene_heading", text: "" }]);
  const [focusedId, setFocusedId] = useState(blocks[0].id);
  const [pendingFocus, setPendingFocus] = useState(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const fileInputRef = useRef(null);
  const textRefs = useRef({});

  const resize = (el) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  useEffect(() => {
    Object.values(textRefs.current).forEach(resize);
  }, [blocks]);

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
        const v = UPPER_TYPES.has(b.type) ? val.toUpperCase() : val;
        return { ...b, text: v };
      })
    );
  };

  const setType = (id, type) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, type, text: UPPER_TYPES.has(type) ? b.text.toUpperCase() : b.text } : b))
    );
    setPendingFocus({ id, pos: "end" });
  };

  const handleKeyDown = (e, id) => {
    const idx = blocks.findIndex((b) => b.id === id);
    const block = blocks[idx];
    const el = e.target;

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
    if (!window.confirm("Start a new script? Unsaved changes will be lost.")) return;
    const id = newId();
    setBlocks([{ id, type: "scene_heading", text: "" }]);
    setTitle("Untitled Screenplay");
    setAuthor("");
    setPendingFocus({ id, pos: "start" });
  };

  const handleSave = () => {
    const text = generateFountain(blocks, title, author);
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

  const handleLoadClick = () => fileInputRef.current?.click();

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { title: t, author: a, blocks: b } = parseFountain(String(reader.result));
      setTitle(t || file.name.replace(/\.[^.]+$/, ""));
      setAuthor(a || "");
      setBlocks(b);
      setPendingFocus({ id: b[0].id, pos: "start" });
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const wordCount = blocks.reduce((sum, b) => sum + (b.text.trim() ? b.text.trim().split(/\s+/).length : 0), 0);
  const pageEstimate = Math.max(1, Math.round(wordCount / 230));

  const focusedType = blocks.find((b) => b.id === focusedId)?.type || "action";

  return (
    <div style={styles.app}>
      <style>{GLOBAL_CSS}</style>

      {/* Header */}
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
          <button style={styles.btn} onClick={handleNew}>New</button>
          <button style={styles.btn} onClick={handleLoadClick}>Load</button>
          <input ref={fileInputRef} type="file" accept=".fountain,.txt" style={{ display: "none" }} onChange={handleFile} />
          <button style={styles.btn} onClick={() => window.print()}>Print</button>
          <button style={styles.btnPrimary} onClick={handleSave}>Save .fountain</button>
        </div>
      </div>

      <div style={styles.body}>
        {/* Left rail */}
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

          {!railCollapsed && (
            <div style={styles.railHint}>
              <div><b>Tab</b> — cycle format</div>
              <div><b>Shift+Tab</b> — cycle back</div>
              <div><b>Enter</b> — new element</div>
              <div><b>Shift+Enter</b> — line break</div>
            </div>
          )}
        </div>

        {/* Page */}
        <div style={styles.pageWrap}>
          <div style={styles.page} className="print-page">
            {blocks.map((b) => (
              <textarea
                key={b.id}
                ref={(el) => (textRefs.current[b.id] = el)}
                value={b.text}
                placeholder={PLACEHOLDER[b.type]}
                onFocus={() => setFocusedId(b.id)}
                onChange={(e) => {
                  updateText(b.id, e.target.value);
                  resize(e.target);
                }}
                onKeyDown={(e) => handleKeyDown(e, b.id)}
                rows={1}
                spellCheck={b.type === "action" || b.type === "dialogue"}
                style={{
                  ...styles.line,
                  ...TYPE_STYLE[b.type],
                  fontWeight: b.type === "character" || b.type === "scene_heading" ? 700 : 400,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div style={styles.statusBar} className="no-print">
        <span style={styles.statusPill}>{LABELS[focusedType]}</span>
        <span style={styles.statusText}>{wordCount} words · ~{pageEstimate} page{pageEstimate === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Styles
--------------------------------------------------------------- */
const INK = "#1b1a17";
const PAPER = "#fbf9f4";
const GOLD = "#c9a24c";
const MUTE = "#948e7d";
const LINE = "#3a372f";

const styles = {
  app: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: INK,
    color: PAPER,
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "10px 18px",
    borderBottom: `1px solid ${LINE}`,
    flexWrap: "wrap",
  },
  brand: { display: "flex", alignItems: "center", gap: "8px", minWidth: "120px" },
  brandMark: { color: GOLD, fontSize: "18px" },
  brandText: { fontSize: "13px", letterSpacing: "3px", fontWeight: 700, color: GOLD },
  titleFields: { display: "flex", gap: "8px", flex: 1, minWidth: "240px" },
  titleInput: {
    background: "transparent",
    border: "none",
    borderBottom: `1px solid ${LINE}`,
    color: PAPER,
    fontSize: "14px",
    padding: "4px 2px",
    flex: 2,
    minWidth: "120px",
    outline: "none",
  },
  authorInput: {
    background: "transparent",
    border: "none",
    borderBottom: `1px solid ${LINE}`,
    color: MUTE,
    fontSize: "13px",
    padding: "4px 2px",
    flex: 1,
    minWidth: "100px",
    outline: "none",
  },
  headerActions: { display: "flex", gap: "8px" },
  btn: {
    background: "transparent",
    color: PAPER,
    border: `1px solid ${LINE}`,
    borderRadius: "3px",
    padding: "7px 12px",
    fontSize: "12px",
    cursor: "pointer",
    letterSpacing: "0.5px",
  },
  btnPrimary: {
    background: GOLD,
    color: INK,
    border: `1px solid ${GOLD}`,
    borderRadius: "3px",
    padding: "7px 14px",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: "0.5px",
  },
  body: { flex: 1, display: "flex", overflow: "hidden" },
  rail: {
    width: "168px",
    borderRight: `1px solid ${LINE}`,
    padding: "16px 10px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    overflowY: "auto",
    overflowX: "hidden",
    flexShrink: 0,
    transition: "width 0.15s ease",
  },
  railCollapsed: { width: "48px", padding: "16px 6px", alignItems: "center" },
  railToggle: {
    background: "transparent",
    border: `1px solid ${LINE}`,
    color: MUTE,
    borderRadius: "3px",
    padding: "6px 8px",
    fontSize: "11px",
    cursor: "pointer",
    marginBottom: "8px",
    width: "100%",
  },
  railLabel: { fontSize: "10px", letterSpacing: "2px", color: MUTE, marginBottom: "4px", paddingLeft: "4px" },
  railBtn: {
    background: "transparent",
    border: `1px solid ${LINE}`,
    color: PAPER,
    borderRadius: "3px",
    padding: "8px 10px",
    fontSize: "12px",
    textAlign: "left",
    cursor: "pointer",
    width: "100%",
  },
  railBtnCollapsed: { textAlign: "center", padding: "8px 0", fontWeight: 700 },
  railBtnActive: { background: GOLD, color: INK, border: `1px solid ${GOLD}`, fontWeight: 700 },
  railHint: { marginTop: "18px", fontSize: "10.5px", color: MUTE, lineHeight: 1.8, paddingLeft: "4px" },
  pageWrap: { flex: 1, overflowY: "auto", padding: "32px 24px", display: "flex", justifyContent: "center" },
  page: {
    background: PAPER,
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
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: "12pt",
    lineHeight: 1.5,
    color: "#1a1a1a",
    padding: 0,
    margin: 0,
  },
  statusBar: {
    display: "flex",
    justifyContent: "space-between",
    padding: "6px 18px",
    borderTop: `1px solid ${LINE}`,
    fontSize: "11.5px",
    color: MUTE,
  },
  statusPill: {
    background: "rgba(201,162,76,0.15)",
    color: GOLD,
    border: `1px solid ${GOLD}`,
    borderRadius: "3px",
    padding: "2px 8px",
    fontWeight: 700,
    letterSpacing: "0.5px",
    fontSize: "10.5px",
  },
  statusText: {},
};

const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  textarea::placeholder { color: #b9b3a0; }
  textarea:focus { background: rgba(201,162,76,0.06); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: ${INK}; }
  ::-webkit-scrollbar-thumb { background: ${LINE}; border-radius: 5px; }
  @media print {
    .no-print { display: none !important; }
    body, html { background: white !important; }
    .print-page { box-shadow: none !important; margin: 0 !important; }
  }
`;
