/* ---------------------------------------------------------------------
   PROSPECTUS PDF PARSER
   Standalone module: takes a program prospectus PDF (organized the way most
   Philippine engineering curricula are — "Year, Term" section headers
   followed by rows of Course Code / Title / Units / Lec / Lab hours) and
   extracts a best-effort list of {year, yearLabel, term, code, title,
   units, lec, lab} entries. Exposes window.parseProspectusPdf(file).

   PDF text extraction happens via Mozilla's pdf.js, loaded lazily from a
   CDN only when this is actually used — the rest of the app stays fully
   self-contained/offline. This is a heuristic parser: PDF layouts vary, so
   results should always be reviewed/corrected by a human before use (the
   app does this via a review table), never trusted blindly.
--------------------------------------------------------------------- */
(function(){
"use strict";

const PDFJS_VERSION = "3.11.174";
const PDFJS_SCRIPT = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

let loadPromise = null;
function ensurePdfJsLoaded(){
  if(window.pdfjsLib) return Promise.resolve();
  if(loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject)=>{
    const script = document.createElement("script");
    script.src = PDFJS_SCRIPT;
    script.onload = ()=>{
      if(window.pdfjsLib){
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve();
      } else {
        reject(new Error("pdf.js loaded but window.pdfjsLib was not found."));
      }
    };
    script.onerror = ()=> reject(new Error("Could not load the PDF-reading library from the internet — check your connection, or use CSV import instead."));
    document.head.appendChild(script);
  });
  return loadPromise;
}

async function extractPdfText(file){
  await ensurePdfJsLoaded();
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for(let i=1; i<=doc.numPages; i++){
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    content.items.forEach(item=>{
      line += item.str;
      if(item.hasEOL){
        text += line + "\n";
        line = "";
      } else {
        line += " ";
      }
    });
    if(line.trim()) text += line + "\n";
  }
  return text;
}

/* ---- Heuristic table parser (ported from a Python prototype validated
   against a real BSEE prospectus) ---- */
const TERM_RE = /(First|Second|Third|Fourth|Fifth)\s+Year,\s+(First|Second)\s+Semester|(First|Second|Third|Fourth|Fifth)\s+Year,\s+Summer\s+Term/;
const CODE_RE = /^([A-Z]{2,6}\d{3}(?:\.\d+)?)\s+(.*)$/;
const STOP_RE = /GRAND TOTAL/i; // marks the end of the fixed curriculum (electives follow)
const YEAR_WORD = { First:1, Second:2, Third:3, Fourth:4, Fifth:5 };
const YEAR_LABEL = { 1:"First Year", 2:"Second Year", 3:"Third Year", 4:"Fourth Year", 5:"Fifth Year" };

function find4NumberWindow(tokens){
  // Finds the trailing [Units, Lec, Lab, Total] run — validated by Lec+Lab===Total — scanning
  // from the end so a stray digit earlier in a title (e.g. "Calculus ... 1") isn't mistaken for it.
  for(let i=tokens.length-4; i>=0; i--){
    const w = tokens.slice(i, i+4);
    if(w.every(t=>/^-?\d+$/.test(t))){
      const nums = w.map(Number);
      if(nums[1] + nums[2] === nums[3]) return i;
    }
  }
  return null;
}
function hasTrailing4(rest){
  return find4NumberWindow(rest.split(/\s+/).filter(Boolean)) !== null;
}

function parseProspectusText(text){
  const rawLines = text.split("\n").map(l=>l.trim()).filter(Boolean);

  // Merge a title that wrapped onto the next PDF line (row lacks its trailing numbers yet,
  // and the next line isn't itself a new course row or section header).
  const merged = [];
  for(let i=0; i<rawLines.length; i++){
    let line = rawLines[i];
    const cm = line.match(CODE_RE);
    if(cm && !hasTrailing4(cm[2]) && i+1 < rawLines.length){
      const nxt = rawLines[i+1];
      if(!CODE_RE.test(nxt) && !TERM_RE.test(nxt)){
        line = line + " " + nxt;
        i++;
      }
    }
    merged.push(line);
  }

  const courses = [];
  let curYear = null, curTerm = null, stopped = false;

  merged.forEach(line=>{
    if(STOP_RE.test(line)){ stopped = true; return; }
    if(stopped) return;

    const tm = line.match(TERM_RE);
    if(tm){
      if(tm[1]){ curYear = YEAR_WORD[tm[1]]; curTerm = tm[2] + " Semester"; }
      else { curYear = YEAR_WORD[tm[3]]; curTerm = "Summer Term"; }
      return;
    }

    const cm = line.match(CODE_RE);
    if(!cm || curYear == null) return;
    const code = cm[1];
    const rest = cm[2];
    let tokens = rest.split(/\s+/).filter(Boolean);
    let found = find4NumberWindow(tokens);
    if(found === null){
      // Fallback: the PDF sometimes glues a column boundary with no space, e.g.
      // "Laboratory1 0 3 3" — force a space between any letter and a following digit and retry.
      const tokens2 = rest.replace(/([a-zA-Z])(\d)/g, "$1 $2").split(/\s+/).filter(Boolean);
      const found2 = find4NumberWindow(tokens2);
      if(found2 === null) return;
      tokens = tokens2; found = found2;
    }
    const title = tokens.slice(0, found).join(" ").trim();
    const nums = tokens.slice(found, found+3).map(Number); // units, lec, lab (drop total)
    if(!title) return;
    courses.push({
      year: curYear, yearLabel: YEAR_LABEL[curYear], term: curTerm,
      code, title, units: nums[0], lec: nums[1], lab: nums[2]
    });
  });

  return courses;
}

window.parseProspectusPdf = async function(file){
  const text = await extractPdfText(file);
  return parseProspectusText(text);
};
// Exposed mainly for testing/debugging from the console.
window.parseProspectusText = parseProspectusText;

})();
