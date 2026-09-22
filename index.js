// PDF Annotation Microservice
//
// Purpose: n8n Cloud can't load external npm packages like pdf-lib inside
// Code nodes, so this tiny standalone service does the actual PDF drawing
// work instead. n8n just calls it over HTTP like any other API.
//
// Single endpoint: POST /annotate
// Input:  { pdfBase64, reviewData, verdicts }
// Output: { annotatedPdfBase64 }

const express = require('express');
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');

// Point values come out of an even division (3 points over 4.5 answers), so
// they arrive as things like 0.6667 or 0.625. Two decimals is plenty on a
// marked page, and String() drops the trailing zeros so 0.5 stays "0.5"
// and 1 stays "1" rather than becoming "0.50" and "1.00".
function fmtPoints(n) {
  if (n === null || n === undefined) return '?';
  return String(Math.round(Number(n) * 100) / 100);
}

const app = express();

// Point size of every score mark. Shared so the vertical anchoring maths
// and the actual drawText call can never drift apart.
const MARK_FONT_SIZE = 10;

// Margin-mode marks are the only thing in the right margin and carry the row
// on their own, so they are one point larger and bold. Grammatik marks sit on
// the handwriting they judge and stay at MARK_FONT_SIZE.
const MARGIN_MARK_FONT_SIZE = MARK_FONT_SIZE + 1;

// Per-exercise subtotals are drawn larger and bold so they read as a
// summary line rather than as just another per-answer mark.
const SUBTOTAL_FONT_SIZE = 12;

// The header total is drawn bold and slightly larger than the subtotals, so
// it stands out at the top of page 1.
const HEADER_FONT_SIZE = 14;

// The grade is the one number the student looks for first, and it sits alone
// in the right margin with nothing around it - so it is the largest thing on
// the page. Enlarged at the teacher's request, 21.09.2026.
const GRADE_FONT_SIZE = 20;

// Unused since 21.09.2026: a row-count warning used to be drawn as a second,
// smaller line under its subtotal. It now shows as the subtotal's own colour
// instead - two numbers under one exercise read as two subtotals. Kept so the
// history of the layout stays legible.
// const WARNING_FONT_SIZE = 8;

// Distance in points from the page's left edge at which subtotals are drawn.
const SUBTOTAL_LEFT_INSET = 2;

// Where the margin-mode mark sits, as a fraction of page width. Carried over
// unchanged from the Hoerverstehen build so that template keeps its exact
// current appearance.
// Where the 'check this yourself' note sits: above every header field the
// schema reports. The highest is the student's name, at y 0.116 on both exam
// types, so 0.045 clears it with room to spare.
const NOTE_TOP_Y = 0.045;

const RIGHT_MARGIN_X_FRACTION = 0.94;

// Exam PDFs with images can be large - raise the body size limit.
app.use(express.json({ limit: '25mb' }));

// Scanned exams (especially from office scanners) very often carry a page
// /Rotate flag (90/180/270) rather than being physically rotated pixels.
// pdf-lib always draws in the page's RAW, unrotated coordinate space, but
// DocuPipe's normalized coordinates describe the VISUALLY correct page as
// a human/OCR sees it. Without this correction, marks land in a rotated,
// scrambled position relative to the actual visible content.
//
// Formulas for 90/270 empirically verified by rendering test PDFs and
// measuring actual pixel output; 0/180 are standard/analytical.
function toRawCoords(x1, y1, rawWidth, rawHeight, rotationAngle) {
  switch (rotationAngle) {
    case 270:
      return { x: rawWidth * (1 - y1), y: rawHeight * (1 - x1) };
    case 90:
      return { x: rawWidth * y1, y: rawHeight * x1 };
    case 180:
      return { x: rawWidth * (1 - x1), y: rawHeight * y1 };
    case 0:
    default:
      return { x: rawWidth * x1, y: rawHeight * (1 - y1) };
  }
}

// DocuPipe wraps every extracted field as { value, review }. Some places
// need the plain value (comparing exerciseType/subPart), others need the
// review block (coordinates). One helper for the value side, used
// everywhere - comparing a wrapped field directly against a string is
// always false/true by accident, which is exactly the kind of silent bug
// this prevents.
function fieldValue(f) {
  return f && typeof f === 'object' && 'value' in f ? f.value : f;
}

// True when a field has usable coordinates to draw against.
function hasBoxes(f) {
  return !!(f && f.review && f.review.boundingBoxes && f.review.boundingBoxes.length > 0);
}

// A field is only worth drawing against if it has coordinates AND DocuPipe
// is not telling us those coordinates are untrustworthy. "low" means it
// could not place the value on the cited line at all, so the box falls back
// to a whole line or lands somewhere unrelated - a confident-looking mark in
// the wrong place is worse than no mark (Nitai, Sep 2026).
function hasTrustedBoxes(f) {
  return hasBoxes(f) && f.review.confidence !== 'low';
}

// How tightly a field's x-positions must cluster before we treat them as a
// real table column (median absolute deviation, in normalized page width),
// and how far from that column a box must sit before we call it misplaced.
// Measured on real scans: genuine columns vary by under 0.02, while the
// scattered blanks of a running-text exercise vary by 0.15 and upwards.
const COLUMN_TIGHTNESS = 0.02;
const MIN_COLUMN_OUTLIER = 0.035;

// A box can be off its column by a little or by a lot, and the two mean
// different things. A small offset is box jitter - the extraction found the
// right answer and boxed it slightly loosely - and snapping it to the column
// is safe. A large offset may instead be a legitimate second answer column
// that the extraction merged into one row per line, where snapping would
// move a correct mark. So small offsets are repaired outright; large ones
// must also have drifted into another field's column before we touch them.
const SMALL_COLUMN_OFFSET = 0.08;

// Beyond this the box has not drifted to a neighbouring column, it has flown
// to another part of the page entirely. Measured: the widest legitimate gap
// between two adjacent answer columns is 0.174, while a box that landed in
// the sentence area sat 0.43 from its column. No plausible second column is
// a quarter of a page away, so past this distance no further evidence is
// needed before repairing.
const LARGE_COLUMN_OUTLIER = 0.25;

// How far outside its own sentence a mark may sit before the row is judged
// wrong. Measured on a real paper: a correction written under its sentence
// sat 0.0005 below it, while a box mis-cited to the table header sat 0.139
// above. Generous below, tight above.
const CONTAINMENT_ABOVE = 0.02;
const CONTAINMENT_BELOW = 0.06;

// How close a box's left edge must be to its sentence's left edge to count
// as having collapsed onto the sentence start. Not zero: the frage box
// often includes the printed item number ("2."), so a collapsed answer box
// starts at the first word rather than exactly at the frage edge.
const COLLAPSE_START_TOLERANCE = 0.035;

// Rows whose 'frage' box is byte-identical to another row's in the same
// exercise. DocuPipe sometimes hands two different questions the same box -
// on one paper rows 1 and 2 of Aufgabe 1 both came back at y1=0.366 - and a
// duplicated frage is wrong about the ROW, not just the column. The column
// repair cannot help, because it only ever substitutes an x. Any row listed
// here must take its row position from one of its own sibling fields
// instead, which are unique to it.
function buildDuplicateFrageSet(answers) {
  const byExercise = new Map();
  answers.forEach((row, idx) => {
    if (!hasBoxes(row && row.frage)) return;
    const ex = String(fieldValue(row.exerciseNumber));
    const sig = row.frage.review.boundingBoxes[0].join(',');
    if (!byExercise.has(ex)) byExercise.set(ex, new Map());
    const sigs = byExercise.get(ex);
    if (!sigs.has(sig)) sigs.set(sig, []);
    sigs.get(sig).push(idx);
  });

  const dupes = new Set();
  for (const [, sigs] of byExercise) {
    // Sharing a frage box is not automatically wrong. Where an exercise puts
    // two answers on one printed line (Aufgabe 2, two marked objects per
    // sentence) every line is legitimately shared, and the shared box is the
    // only thing that tells those two answers apart vertically - treating it
    // as broken there would undo that. So only call it an artefact when the
    // exercise normally holds ONE row per line and a shared box is therefore
    // the exception rather than the rule.
    const singles = [...sigs.values()].filter(v => v.length === 1).length;
    const multis = [...sigs.values()].filter(v => v.length > 1).length;
    if (singles <= multis) continue;
    for (const [, idxs] of sigs) {
      if (idxs.length > 1) idxs.forEach(i => dupes.add(i));
    }
  }
  return dupes;
}

// Median x of every OTHER field in one exercise - i.e. where the other
// columns of this exercise actually sit. Used to tell a genuinely broken box
// (one that has drifted into a different field's column) from a box that is
// merely far from its own column, which happens legitimately when a
// two-column exercise gets merged into one row per line.
function otherFieldMedians(answers, exerciseKey, fieldName) {
  const out = [];
  for (const other of ['frage', 'antwort', 'fall']) {
    if (other === fieldName) continue;
    const xs = [];
    answers.forEach(row => {
      if (String(fieldValue(row.exerciseNumber)) !== String(exerciseKey)) return;
      const f = row[other];
      if (hasBoxes(f)) xs.push(f.review.boundingBoxes[0][0]);
    });
    if (xs.length < 2) continue;
    const s = xs.sort((a, b) => a - b);
    out.push(s[Math.floor(s.length / 2)]);
  }
  return out;
}

// GENERAL REPAIR for DocuPipe's duplicate-text collision.
//
// When two rows in one exercise hold the same text ("Akkusativ" twice,
// "Richtig" twice, "durch" twice), DocuPipe returns the FIRST occurrence's
// box for both - and still reports confidence "high", so the confidence flag
// cannot catch it. Confirmed in node 17 output: Aufgabe 2 rows 5/6 and 7/8
// have byte-identical boxes.
//
// Borrowing the row position from 'frage' repairs the Y axis, because each
// printed line has its own frage. It cannot repair X, so the second answer
// on a line lands in the first answer's column.
//
// X is recoverable because these exercises are grids. Rows that share a
// frage share a printed line, and their answers sit in fixed columns across
// every line. So: learn each column's X from the lines that did NOT collide,
// then give a collided row the X of its own ordinal position. Nothing is
// guessed - the numbers come from other rows of the same exercise.
//
// Lines holding a single answer (Aufgabe 1, 5, 6) form groups of one, can
// never collide within themselves, and are left completely untouched.
function buildColumnRepairMap(answers, fieldName) {
  const repaired = new Map();
  const boxSig = (f) => hasBoxes(f) ? f.review.boundingBoxes[0].join(',') : null;

  // exercise -> printed line -> row indexes on that line
  const byExercise = new Map();
  answers.forEach((row, idx) => {
    if (!hasBoxes(row && row.frage)) return;
    const ex = String(fieldValue(row.exerciseNumber));
    const lineKey = boxSig(row.frage);
    if (!byExercise.has(ex)) byExercise.set(ex, new Map());
    const lines = byExercise.get(ex);
    if (!lines.has(lineKey)) lines.set(lineKey, []);
    lines.get(lineKey).push(idx);
  });

  for (const [exerciseKey, lines] of byExercise) {
    // Rows are grouped by frage box to work out which of them share a
    // printed line. That only holds if the frage boxes are trustworthy, and
    // sometimes they are not: on one paper two different questions in
    // Aufgabe 1 came back with a byte-identical frage box, which made the
    // grouping believe they were two answers on one line and pushed the
    // second into a "column" with a single sample - too few to judge, so its
    // misplaced answer was never repaired.
    //
    // If MOST lines in the exercise hold exactly one row, the exercise is
    // one answer per line and a shared frage box is an artefact rather than
    // a real shared line. Split those groups apart so every row sits in the
    // one real column. Exercises that genuinely put two answers on a line
    // (Aufgabe 2) have most lines holding two rows, and are left alone.
    const singles = [...lines.values()].filter(v => v.length === 1).length;
    const multis = [...lines.values()].filter(v => v.length > 1).length;
    if (multis > 0 && singles > multis) {
      const flattened = new Map();
      let k = 0;
      for (const [, idxs] of lines) {
        for (const i of idxs) flattened.set('row' + (k++), [i]);
      }
      lines.clear();
      for (const [key, v] of flattened) lines.set(key, v);
    }
    // Learn column positions, using only lines whose boxes are all present
    // and all distinct - a collided line would teach the wrong position.
    const columnX = new Map(); // ordinal -> [x1, ...]
    for (const [, idxs] of lines) {
      const sigs = idxs.map(i => boxSig(answers[i] && answers[i][fieldName]));
      if (sigs.some(s => !s)) continue;
      if (new Set(sigs).size !== sigs.length) continue;
      idxs.forEach((i, ord) => {
        const x = answers[i][fieldName].review.boundingBoxes[0][0];
        if (!columnX.has(ord)) columnX.set(ord, []);
        columnX.get(ord).push(x);
      });
    }
    if (columnX.size === 0) continue;

    for (const [, idxs] of lines) {
      const sigs = idxs.map(i => boxSig(answers[i] && answers[i][fieldName]));
      idxs.forEach((i, ord) => {
        if (!sigs[ord]) return;
        if (!sigs.some((s, o) => s === sigs[ord] && o !== ord)) return; // not a duplicate
        const samples = columnX.get(ord);
        if (!samples || !samples.length) return;
        const sorted = [...samples].sort((a, b) => a - b);
        repaired.set(`${i}:${fieldName}`, sorted[Math.floor(sorted.length / 2)]); // median
      });
    }

    // SECOND PASS - a box that is simply in the wrong column.
    //
    // Distinct from the duplicate case: nothing is repeated, DocuPipe just
    // returned a position that belongs to another column entirely (seen on
    // Aufgabe 1, where one long answer was boxed at x=0.0979 in the Frage
    // column while every other answer sat at ~0.47). Confidence was "high",
    // so nothing else catches it.
    //
    // A table column is a tight cluster, so an outlier is obvious - but only
    // if the field really forms a column. In running text (Aufgabe 4) the
    // blanks are scattered across the line and every value is legitimately
    // far from the median, so "repairing" there would wreck correct
    // positions. The median absolute deviation tells the two apart without
    // needing to know which exercise type we're looking at: a real column
    // has a tiny MAD, scattered running text has a large one.
    for (const [ord, xs] of columnX) {
      if (xs.length < 3) continue; // too few samples to call anything an outlier
      const sorted = [...xs].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const devs = xs.map(x => Math.abs(x - median)).sort((a, b) => a - b);
      const mad = devs[Math.floor(devs.length / 2)];
      if (mad > COLUMN_TIGHTNESS) continue; // not a column - leave every row alone
      const threshold = Math.max(MIN_COLUMN_OUTLIER, mad * 8);

      for (const [, idxs] of lines) {
        const i = idxs[ord];
        if (i === undefined) continue;
        const key = `${i}:${fieldName}`;
        if (repaired.has(key)) continue; // already handled as a duplicate
        const g = answers[i] && answers[i][fieldName];
        if (!hasBoxes(g)) continue;
        const x = g.review.boundingBoxes[0][0];
        const deviation = Math.abs(x - median);
        if (deviation <= MIN_COLUMN_OUTLIER) continue;

        // Being far from its own column is NOT enough to call an ANSWER box
        // wrong. Where an exercise has two answer columns but the extraction
        // merged each line into one row, the surviving answers are a
        // legitimate mix of both columns, and "repairing" the ones from the
        // second column would move correct marks to the wrong place. So for
        // antwort and fall, require the outlier to have landed inside
        // another field's column - which is what a genuinely broken box
        // does, like the Aufgabe 1 answer returned at x=0.0979 sitting in
        // the Frage column.
        //
        // 'frage' is exempt: it is the question or sentence, always a single
        // leftmost column in every exercise type here, so it has no second
        // column to be legitimately far from - and being leftmost, it can
        // never drift INTO another field's column either, which would
        // otherwise make it unrepairable by the rule above.
        if (fieldName !== 'frage' &&
            deviation > SMALL_COLUMN_OFFSET &&
            deviation <= LARGE_COLUMN_OUTLIER) {
          const drifted = otherFieldMedians(answers, exerciseKey, fieldName)
            .some(m => Math.abs(x - m) < MIN_COLUMN_OUTLIER);
          if (!drifted) continue;
        }

        repaired.set(key, median);
      }
    }

  }
  return repaired;
}

// Learns where the Richtig / Falsch checkbox columns actually sit.
//
// In true_false_correction the schema merges both answers into one string:
// "Richtig" when the sentence is fine, "Falsch, vom" when the student also
// wrote a correction. DocuPipe boxes whatever it read - so a bare "Richtig"
// lands on the checkbox, while "Falsch, vom" lands on the correction word
// out in the sentence. That is why judgment marks currently scatter between
// the table and the text.
//
// Rows whose answer is a BARE judgment word are the ones boxed on a
// checkbox, so they tell us where that column is. Keyed per exercise and per
// word, so "richtig" and "falsch" are learned independently. Nothing is
// assumed about table geometry - if a column was never observed, the caller
// degrades honestly rather than inventing a position.
function buildJudgmentColumnMap(answers) {
  const raw = new Map(); // exercise -> word -> [x1, ...]
  answers.forEach(row => {
    const a = row && row.antwort;
    if (!hasTrustedBoxes(a)) return;
    const v = fieldValue(a);
    if (typeof v !== 'string') return;
    const m = v.trim().match(/^(richtig|falsch)$/i);
    if (!m) return; // has a correction appended - boxed on the text, not the checkbox
    const ex = String(fieldValue(row.exerciseNumber));
    if (!raw.has(ex)) raw.set(ex, new Map());
    const words = raw.get(ex);
    const w = m[1].toLowerCase();
    if (!words.has(w)) words.set(w, []);
    words.get(w).push(a.review.boundingBoxes[0][0]);
  });

  const out = new Map();
  for (const [ex, words] of raw) {
    const medians = new Map();
    for (const [w, xs] of words) {
      const s = [...xs].sort((a, b) => a - b);
      medians.set(w, s[Math.floor(s.length / 2)]);
    }
    out.set(ex, medians);
  }
  return out;
}

// Which part of a bounding box the mark's baseline should sit on.
//
// boundingBoxes are [x1, y1, x2, y2] with a top-left origin, so y1 is the
// box TOP and y2 its BOTTOM. drawText places the BASELINE at the y it is
// given and the glyphs grow upward from there, so anchoring on the box top
// renders the whole mark ABOVE the field it belongs to - which is how
// Aufgabe 5's row 1 ended up on the table header.
//
// Anchoring on the bottom fixed that but overshot for multi-line fields: a
// three-line handwritten question is one tall box, and its bottom is the
// LAST line, so the mark landed on the final line of the question, right
// against the next row.
//
// What we actually want is the FIRST line of the field: drop one line-height
// below the box top, then clamp so a short box can never push the mark out
// through its own bottom. Single-line boxes are barely affected (their
// height is about one line anyway); tall boxes get the mark at the top,
// where a teacher would write it.
function rowAnchorY(box, lineHeightNorm) {
  if (!box) return 0;
  if (box.length < 4) return box[1];
  return Math.min(box[3], box[1] + lineHeightNorm);
}

// Moves a raw PDF point "visually down" the page by `distance`, for any page
// rotation. Raw PDF y grows upward, but WHICH raw axis counts as visually
// down depends on the page's /Rotate flag - the same mapping toRawCoords
// encodes. Centralised because getting it wrong fails silently: the mark
// still draws, just drifting in the wrong direction. Pass a negative
// distance to move visually up.
// MISSING ROW POSITION - a row whose own 'frage' has no usable box.
//
// Seen on Aufgabe 1b row 3 ("Wem schenkt Lisa ..."): DocuPipe returned no
// box at all for the question (confidence low), and its 'antwort' was cited
// to the word "Freund?" in the ROW ABOVE. With no frage, the frage verdict
// was skipped, and nothing could tell that the antwort box sat in the wrong
// row - containment and column repair both need a frage to work from.
//
// The row's position is still in the data. Rows are listed in page order,
// so a row must sit BETWEEN the frage of the row before it and the frage of
// the row after it. A sibling box (antwort/fall) that lies in that gap is
// on the right row; one that lies inside a neighbour's band is not. From a
// sibling in the gap we take the row's height, and from the other rows of
// the exercise we take the frage column's left edge and typical width.
//
// The inferred box is tagged confidence "medium" and inferred: true, so it
// can be told apart from a box DocuPipe reported itself.
function inferMissingFrageBoxes(answers, warnings) {
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const byExercise = new Map();
  answers.forEach((row, idx) => {
    if (!row) return;
    const ex = String(fieldValue(row.exerciseNumber));
    if (!byExercise.has(ex)) byExercise.set(ex, []);
    byExercise.get(ex).push(idx);
  });

  for (const [, idxs] of byExercise) {
    const trusted = idxs.filter(i => hasTrustedBoxes(answers[i].frage));
    if (trusted.length < 2) continue;
    const colX = med(trusted.map(i => answers[i].frage.review.boundingBoxes[0][0]));
    const colW = med(trusted.map(i => { const b = answers[i].frage.review.boundingBoxes[0]; return b[2] - b[0]; }));

    idxs.forEach((i, pos) => {
      const row = answers[i];
      if (hasTrustedBoxes(row.frage)) return;
      const prev = idxs.slice(0, pos).reverse().find(j => hasTrustedBoxes(answers[j].frage));
      const next = idxs.slice(pos + 1).find(j => hasTrustedBoxes(answers[j].frage));

      const inGap = [row.antwort, row.fall].filter(hasTrustedBoxes).find(f => {
        const b = f.review.boundingBoxes[0];
        const mid = (b[1] + b[3]) / 2;
        if (prev !== undefined) {
          const pf = answers[prev].frage.review;
          if (pf.page === f.review.page && mid <= pf.boundingBoxes[0][3]) return false;
        }
        if (next !== undefined) {
          const nf = answers[next].frage.review;
          if (nf.page === f.review.page && mid >= nf.boundingBoxes[0][1]) return false;
        }
        return true;
      });
      if (!inGap) return;

      const b = inGap.review.boundingBoxes[0];
      row.frage = {
        value: fieldValue(row.frage),
        review: {
          page: inGap.review.page,
          boundingBoxes: [[colX, b[1], colX + colW, b[3]]],
          confidence: 'medium',
          inferred: true
        }
      };
      warnings.push(`answerIndex ${i}, field frage - DocuPipe gave no position for this question; row position inferred from this row's own answer boxes`);
    });
  }
}

// MERGED ANSWERS - one extracted row holding several answers ("Nominativ,
// Akkusativ"). DocuPipe boxes the whole run, from the first answer's left
// edge to the last answer's right edge. When grading returns one verdict per
// answer (verdict.part = 0, 1, ...), each needs its own spot inside that
// box. The printed answer lines in these exercises are equal-width columns,
// so answer k starts k/N of the way across. The exercise-wide median of left
// edge and width is used, rather than each row's own, so the marks form
// straight columns even though handwriting length varies from row to row.
function buildMergedSplitMap(answers) {
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const groups = new Map(); // "exercise|field|N" -> { x1s, ws }
  answers.forEach(row => {
    if (!row) return;
    for (const fieldName of ['antwort', 'fall']) {
      const f = row[fieldName];
      if (!hasTrustedBoxes(f)) continue;
      const n = countParts(fieldValue(f));
      if (n < 2) continue;
      const b = f.review.boundingBoxes[0];
      const key = `${fieldValue(row.exerciseNumber)}|${fieldName}|${n}`;
      if (!groups.has(key)) groups.set(key, { x1s: [], ws: [] });
      groups.get(key).x1s.push(b[0]);
      groups.get(key).ws.push(b[2] - b[0]);
    }
  });
  const out = new Map();
  for (const [key, g] of groups) {
    if (g.x1s.length < 2) continue; // a single row gives no column to align to
    out.set(key, { x1: med(g.x1s), w: med(g.ws) });
  }
  return out;
}

// Answers written side by side come back joined as "Nominativ, Akkusativ"
// on some papers and "Nominativ / Akkusativ" on others.
const PART_SEPARATOR = /[,\/;]/;

function countParts(v) {
  if (typeof v !== 'string' || !PART_SEPARATOR.test(v)) return 1;
  return v.split(PART_SEPARATOR).filter(t => t.trim()).length;
}

// Median left edge of one field across an exercise - roughly where that
// column starts. Deliberately NOT required to be a tight column: it is only
// used once a box has already been proven to sit in the wrong row, where the
// start of the right column beats every other available x.
function fieldColumnStart(answers, exerciseKey, fieldName) {
  const xs = [];
  answers.forEach(row => {
    if (!row || String(fieldValue(row.exerciseNumber)) !== String(exerciseKey)) return;
    if (hasTrustedBoxes(row[fieldName])) xs.push(row[fieldName].review.boundingBoxes[0][0]);
  });
  if (xs.length < 3) return null;
  const s = xs.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// MISSING BLANK POSITION - a fill-in answer DocuPipe could not locate.
//
// Seen on Aufgabe 6 row 4 ("Ich freue mich über ___ Erfolg."): the answer
// "jeden" came back with no box (confidence low), so its mark was skipped.
//
// The blank's position is recoverable from the sentence itself. Its left
// edge sits after the printed text in front of "___", and printed text has
// known proportions. The OTHER rows of the same exercise, whose answers were
// located, give the scale: how far their blank sits from their sentence's
// left edge versus how wide their prefix text is. One scale fitted across
// those rows, applied to this row's own prefix, gives this row's blank.
// Measured on the paper that showed the problem: the fitted estimate landed
// within 0.006 of the real answer on two rows and within 0.026 on the third.
const BLANK_MARKER = /_{2,}|…|\.{3,}/;

function inferMissingBlankBoxes(answers, warnings, font) {
  const byExercise = new Map();
  answers.forEach((row, idx) => {
    if (!row) return;
    const ex = String(fieldValue(row.exerciseNumber));
    if (!byExercise.has(ex)) byExercise.set(ex, []);
    byExercise.get(ex).push(idx);
  });

  const prefixOf = (row) => {
    const text = fieldValue(row.frage);
    if (typeof text !== 'string') return null;
    const m = text.match(BLANK_MARKER);
    return m ? text.slice(0, m.index) : null;
  };

  for (const [, idxs] of byExercise) {
    const samples = [];
    for (const i of idxs) {
      const row = answers[i];
      const prefix = prefixOf(row);
      if (prefix === null || !hasTrustedBoxes(row.frage) || !hasTrustedBoxes(row.antwort)) continue;
      if (row.frage.review.page !== row.antwort.review.page) continue;
      const dx = row.antwort.review.boundingBoxes[0][0] - row.frage.review.boundingBoxes[0][0];
      const w = font.widthOfTextAtSize(prefix, 1);
      if (dx < 0 || w <= 0) continue;
      samples.push({ w, dx, box: row.antwort.review.boundingBoxes[0] });
    }
    if (samples.length < 2) continue;
    const scale = samples.reduce((n, s) => n + s.w * s.dx, 0) / samples.reduce((n, s) => n + s.w * s.w, 0);
    const widths = samples.map(s => s.box[2] - s.box[0]).sort((a, b) => a - b);
    const boxWidth = widths[Math.floor(widths.length / 2)];

    for (const i of idxs) {
      const row = answers[i];
      if (hasTrustedBoxes(row.antwort) || !hasTrustedBoxes(row.frage)) continue;
      const prefix = prefixOf(row);
      if (prefix === null) continue;
      const fb = row.frage.review.boundingBoxes[0];
      const x = fb[0] + scale * font.widthOfTextAtSize(prefix, 1);
      row.antwort = {
        value: fieldValue(row.antwort),
        review: {
          page: row.frage.review.page,
          boundingBoxes: [[x, fb[1], x + boxWidth, fb[3]]],
          confidence: 'medium',
          inferred: true
        }
      };
      warnings.push(`answerIndex ${i}, field antwort - DocuPipe gave no position for this answer; blank position estimated from the sentence text and the other rows of the exercise`);
    }
  }
}

// FLOWN CASE BOX - a 'fall' box that landed far outside its column.
//
// Seen on Aufgabe 6 row 3: the case "Genitiv" was boxed at x=0.286, out in
// the sentence area, while every other row's case sat in the "Fall:" column
// around x=0.72. Its mark therefore appeared next to the NEXT row's answer,
// where it looked like that row's score. The general column repair did not
// catch it: with only four rows, a single wild value makes the spread look
// too wide to count as a column at all.
//
// So this check asks a simpler question, only of 'fall' (a case is always
// written in a case column, never inside running text): do most rows agree
// on one column, and is this box a quarter of a page away from it? If so the
// box is wrong in both directions - it carries some other spot's height too
// - so the column comes from the agreeing rows and the height from the row's
// own sentence.
function repairFlownFallBoxes(answers, warnings) {
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const byExercise = new Map();
  answers.forEach((row, idx) => {
    if (!row || !hasTrustedBoxes(row.fall)) return;
    const ex = String(fieldValue(row.exerciseNumber));
    if (!byExercise.has(ex)) byExercise.set(ex, []);
    byExercise.get(ex).push(idx);
  });

  for (const [, idxs] of byExercise) {
    if (idxs.length < 3) continue;
    const xs = idxs.map(i => answers[i].fall.review.boundingBoxes[0][0]);
    const m = med(xs);
    const inliers = xs.filter(x => Math.abs(x - m) <= 0.1);
    if (inliers.length < 2 || inliers.length / xs.length < 0.6) continue;
    const columnX = med(inliers);

    for (const i of idxs) {
      const row = answers[i];
      const b = row.fall.review.boundingBoxes[0];
      if (Math.abs(b[0] - columnX) <= LARGE_COLUMN_OUTLIER) continue;
      if (!hasTrustedBoxes(row.frage) || row.frage.review.page !== row.fall.review.page) continue;
      const fb = row.frage.review.boundingBoxes[0];
      row.fall = {
        value: fieldValue(row.fall),
        review: {
          ...row.fall.review,
          boundingBoxes: [[columnX, fb[1], columnX + (b[2] - b[0]), fb[3]]],
          inferred: true
        }
      };
      warnings.push(`answerIndex ${i}, field fall - box was far outside the case column (x=${b[0].toFixed(3)}); moved to the column on this row`);
    }
  }
}

// A box can be present and "trusted" yet say nothing about where the answer
// is. Seen on Aufgabe 5: one correction came back boxed across the entire
// table (x 0.09 to 0.91, three rows tall). Anything that wide is a region,
// not an answer, and is handled as if no box had been returned.
const MAX_ANSWER_BOX_WIDTH = 0.6;

function isUsableAnswerBox(field) {
  if (!hasTrustedBoxes(field)) return false;
  const b = field.review.boundingBoxes[0];
  return (b[2] - b[0]) <= MAX_ANSWER_BOX_WIDTH;
}

function hasValue(field) {
  const v = fieldValue(field);
  return v !== null && v !== undefined && String(v).trim() !== '';
}

// MISSING ANSWER/CASE POSITION - the row is known, the box is not.
//
// Runs after the frage and blank inference, so every row that can have a
// known sentence position already has one. For each answer or case that
// still has no usable box, the position is rebuilt from what IS known:
//
//   - The ROW always comes from the row's own sentence (frage).
//   - The COLUMN depends on the kind of exercise:
//       qa_composition (table) and the "Fall:" column of fill_blank_with_case:
//         the column the other rows of the exercise agree on.
//       fill_blank_with_case answer whose sentence carries no "___" marker:
//         the start of the sentence - the blank's place cannot be derived
//         without the marker, and the right row is the part that matters.
//       true_false_correction: the judgment mark is moved into the
//         Richtig/Falsch column later anyway; a correction mark goes just
//         after the end of its sentence, where it is clearly that
//         sentence's and collides with nothing.
//
// Seen on one paper: Aufgabe 1a row 2's answer, Aufgabe 5 row 5 (no box at
// all, so both its judgment and correction marks vanished), Aufgabe 5 row 3
// (the table-wide box), and Aufgabe 6 row 3's answer.
const INFER_TYPES = ['qa_composition', 'fill_blank_with_case', 'true_false_correction'];

function inferMissingFieldBoxes(answers, warnings) {
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  // Column per exercise and field, from the rows that agree with each other.
  const columnOf = (exerciseKey, fieldName) => {
    const boxes = [];
    answers.forEach(r => {
      if (!r || String(fieldValue(r.exerciseNumber)) !== exerciseKey) return;
      if (isUsableAnswerBox(r[fieldName]) && !r[fieldName].review.inferred) boxes.push(r[fieldName].review.boundingBoxes[0]);
    });
    if (boxes.length < 2) return null;
    const m = med(boxes.map(b => b[0]));
    const inliers = boxes.filter(b => Math.abs(b[0] - m) <= 0.1);
    if (inliers.length < 2 || inliers.length / boxes.length < 0.6) return null;
    return { x: med(inliers.map(b => b[0])), w: med(inliers.map(b => b[2] - b[0])) };
  };

  answers.forEach((row, i) => {
    if (!row) return;
    const type = fieldValue(row.exerciseType);
    if (!INFER_TYPES.includes(type)) return;
    if (!hasTrustedBoxes(row.frage)) return;
    const exerciseKey = String(fieldValue(row.exerciseNumber));
    const fb = row.frage.review.boundingBoxes[0];
    const page = row.frage.review.page;

    for (const fieldName of ['antwort', 'fall']) {
      const f = row[fieldName];
      if (!hasValue(f) || isUsableAnswerBox(f)) continue;

      let box = null;
      let how = '';
      if (type === 'true_false_correction') {
        if (fieldName !== 'antwort') continue;
        box = [fb[2] + 0.01, fb[1], fb[2] + 0.08, fb[3]];
        how = 'correction placed after the end of its sentence, judgment in the table column';
      } else if (type === 'fill_blank_with_case' && fieldName === 'antwort') {
        box = [fb[0], fb[1], fb[0] + 0.08, fb[3]];
        how = 'placed at the start of its sentence (no blank marker to locate the gap)';
      } else {
        const col = columnOf(exerciseKey, fieldName);
        if (!col) continue;
        box = [col.x, fb[1], col.x + col.w, fb[3]];
        how = `placed in the ${fieldName} column on this row`;
      }

      row[fieldName] = {
        value: fieldValue(f),
        review: { page, boundingBoxes: [box], confidence: 'medium', inferred: true }
      };
      warnings.push(`answerIndex ${i}, field ${fieldName} - no usable position from DocuPipe; ${how}`);
    }
  });
}

function nudgeVisualDown(x, y, distance, rotationAngle) {
  switch (rotationAngle) {
    case 270: return { x: x - distance, y };
    case 90:  return { x: x + distance, y };
    case 180: return { x, y: y + distance };
    default:  return { x, y: y - distance };
  }
}

app.get('/', (req, res) => {
  res.send('PDF annotation service is running. POST to /annotate, or /merge to join annotated papers into one PDF.');
});

app.post('/annotate', async (req, res) => {
  try {
    const { pdfBase64, reviewData, verdicts, totalPointsAwarded, totalPointsPossible, subtotals, gradeRounding, bonusPoints, examType } = req.body;

    // ONE service, TWO placement strategies - merged 21.09.2026.
    //
    // Until now the two exam types were served by swapping this file on Render
    // by hand. That stopped working once one workflow began serving both types
    // through one endpoint: the five Kurztests of 21.09 were annotated by the
    // Hoerverstehen build, which put every mark in the right margin, and the
    // marks landed nowhere near the items.
    //
    //   Grammatik      - the mark sits ON the item, and the repair layer below
    //                    reconstructs a column when the coordinate is wrong.
    //                    Its thresholds are measured on the Kurztest layout.
    //   everything else - one score per row in the right margin, which is what
    //                    the Hoerverstehen template was built for and what it
    //                    still does, unchanged.
    //
    // Anything not on this list uses the margin, so a new exam type still gets
    // the safe behaviour rather than a repair layer tuned elsewhere.
    //
    // Geschichte joined the list on 22.09.2026, at the teacher's request after
    // reading the first annotated paper: in margin mode the marks for 1b's
    // four table rows and 2a's six list lines all resolve to nearly the same
    // right-margin height and pile up on each other - the run logged "nudged:
    // landed on top of the previous mark" six times, and 4a's three marks came
    // out level with 4b. She asked for them on the item, "like exercise 1 from
    // the Grammatik test".
    //
    // STATED PLAINLY: the repair layer's thresholds were measured on the
    // Kurztest layout, not this one. This gives Geschichte the right STRATEGY;
    // whether every threshold suits an A4 landscape photo of a handwritten
    // sheet is not yet measured, so the first paper needs looking at.
    const ON_ITEM_TYPES = new Set(['grammatik', 'geschichte']);
    const MARGIN_MODE = !ON_ITEM_TYPES.has(String(examType || '').trim().toLowerCase());

    // EXERCISES THE TEACHER HAS TO COUNT HERSELF.
    //
    // A subtotal carrying a warning means something in that exercise was not
    // graded or could not be located. From 21.09.2026 the paper says so by
    // leaving the exercise ALONE: no marks are drawn in it at all — not even
    // the ones with good coordinates — and only its subtotal appears, in
    // amber. A half-marked exercise is worse than an unmarked one, because it
    // invites the reader to trust the half that is there.
    //
    // The header loses its total and its grade for the same reason: both would
    // be arithmetic over an exercise that still needs counting. An amber note
    // names the exercises instead.
    //
    // PER POOL, not per exercise. 5a and 5b sit under one printed heading but
    // are separate point pools, and the teacher's instruction (21.09.2026) is
    // that when only one of them is doubtful she wants BOTH pool subtotals on
    // the page and no combined exercise figure — so she can add them up
    // herself. Suppressing the whole exercise would take the sound half away
    // with the doubtful one.
    const warnedPools = new Set();
    if (Array.isArray(subtotals)) {
      for (const sub of subtotals) {
        if (!sub || !sub.warning) continue;
        warnedPools.add(String(sub.key));
      }
    }

    if (!pdfBase64 || !reviewData || !verdicts) {
      return res.status(400).json({
        error: 'Missing required field(s): pdfBase64, reviewData, verdicts are all required.'
      });
    }

    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();

    // Embedded once, so label widths can be measured properly rather than
    // estimated from character counts. Bold is used for the per-exercise
    // subtotals, which should stand out from the individual marks.
    const labelFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const labelFontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // In margin mode the mark stands alone in the right margin, with no
    // handwriting under it and nothing beside it to anchor the eye - it has to
    // carry its row by itself. One point larger and bold, at the teacher's
    // request after reading the first annotated Hoerverstehen paper
    // (21.09.2026). On Grammatik the mark sits ON the item, where bigger and
    // bolder would compete with the handwriting it is judging, so it is left
    // as it was.
    const markFontSize = MARGIN_MODE ? MARGIN_MARK_FONT_SIZE : MARK_FONT_SIZE;
    const markFont = MARGIN_MODE ? labelFontBold : labelFont;

    // Draws a score with a highlight behind it. Marks sit directly on top of
    // the student's handwriting, so green or red text alone can be hard to
    // pick out against dense blue ink. A near-opaque white pad knocks the
    // handwriting back just enough for the number to read cleanly, while
    // leaving it faintly visible underneath rather than blanking it out.
    // The pad is measured from the real glyph width, so it always fits the
    // text exactly and never over-covers the page.
    function drawLabel(page, text, x, y, size, color, rotationAngle, font) {
      const f = font || labelFont;
      const w = f.widthOfTextAtSize(text, size);
      page.drawRectangle({
        x: x - 2,
        y: y - 0.22 * size,
        width: w + 4,
        height: size * 1.18,
        color: rgb(1, 1, 1),
        opacity: 0.92,
        rotate: degrees(rotationAngle)
      });
      page.drawText(text, { x, y, size, font: f, color, rotate: degrees(rotationAngle) });
      return w;
    }

    let annotatedCount = 0;
    const skipped = [];
    // Marks that were not placed the ordinary way - reported so the
    // workflow can surface them rather than leaving them to be noticed.
    const marginWithheld = [];   // Grammatik: value shown in the margin, not on the item
    const rowRecovered = [];     // margin mode: row taken from the question box
    const positionWarnings = [];
    const lastMarkPosByPage = {};

    // Verdicts now target a SPECIFIC field (frage/antwort/fall) per row,
    // one verdict per gradable part rather than one per whole row.
    // Shallow copy per row: inferMissingFrageBoxes replaces a row's 'frage'
    // object, and that must never leak back into the caller's data.
    const answers = (reviewData.answers || []).map(r => (r ? { ...r } : r));
    inferMissingFrageBoxes(answers, positionWarnings);
    inferMissingBlankBoxes(answers, positionWarnings, labelFont);
    repairFlownFallBoxes(answers, positionWarnings);
    inferMissingFieldBoxes(answers, positionWarnings);
    const mergedSplits = buildMergedSplitMap(answers);

    // Built once per request: which rows have a column position corrupted by
    // the duplicate-text collision, and what their X should actually be.
    // All three graded fields need repairing, not just the answers. 'frage'
    // carries its own verdict in qa_composition, and its box drifts the same
    // way the others do - on one paper it came back indented at x=0.2151
    // instead of the column's 0.0873.
    const columnRepairs = new Map([
      ...buildColumnRepairMap(answers, 'antwort'),
      ...buildColumnRepairMap(answers, 'fall'),
      ...buildColumnRepairMap(answers, 'frage')
    ]);
    const judgmentColumns = buildJudgmentColumnMap(answers);
    const duplicateFrageRows = buildDuplicateFrageSet(answers);

    // Which pools actually produced a verdict. Used to tell a pool that scored
    // zero because the student left it BLANK from one that is doubtful - see
    // the warned-pool block below. Same key construction as node 21.
    const poolOf = (row, markAs) => {
      const sp = fieldValue(row && row.subPart);
      let ps = sp ? String(sp).trim().charAt(0) : '';
      if (fieldValue(row && row.exerciseType) === 'true_false_correction') {
        ps = markAs === 'correction' ? 'b' : 'a';
      }
      return String(fieldValue(row && row.exerciseNumber)) + ps;
    };
    const poolsWithVerdicts = new Set();
    for (const v of verdicts) {
      const r = answers[v.answerIndex];
      if (r) poolsWithVerdicts.add(poolOf(r, v.markAs));
    }

    // A BLANK TASK IS NOT A DOUBT. Change 2 gives a pool with points but no
    // verdicts a synthetic zero carrying "! keine Antwort erfasst" — and that
    // is a settled result, not something the teacher has to recount: nothing
    // was written, so nothing can be worth points. It stays blue and it does
    // not hold back the grade.
    //
    // The test is structural rather than a match on the warning's wording: a
    // pool that produced no verdict at all is exactly the case Change 2
    // synthesises. A pool whose verdicts happen to sum to zero has verdicts,
    // so it is not caught here.
    for (const key of [...warnedPools]) {
      if (!poolsWithVerdicts.has(key)) warnedPools.delete(key);
    }
    const manualCheckPools = [...warnedPools].sort();

    for (const verdict of verdicts) {
      const row = answers[verdict.answerIndex];


      // ANCHOR POLICY for exercise types where the graded field's text can
      // legitimately repeat across rows (true_false_correction's antwort
      // often just says "Richtig"/"Falsch"; case_identification's fall
      // repeats case names like "Akkusativ"; preposition_only's antwort
      // repeats words like "durch"). Confirmed via real node 17 output
      // (Sep 2026):
      //   - Y (row position) is safest taken from 'frage' - each row's own
      //     sentence/phrase is distinct, so its Y is always correctly
      //     unique, immune to the duplicate-text collision that corrupts Y
      //     whenever two rows share identical graded text.
      //   - X (horizontal position), however, is usually MORE precise from
      //     the graded field itself than from frage - e.g. true_false_
      //     correction's antwort X lands right on the Richtig/Falsch
      //     checkbox, or right on the handwritten correction word, while
      //     frage's X is just the constant start of the sentence column.
      // So rather than fully replace one field with the other, take Y from
      // frage and X from the graded field, falling back to frage's own X
      // if the graded field has no coordinates at all.
      const exerciseType = fieldValue(row && row.exerciseType);
      const subPart = fieldValue(row && row.subPart);

      // Flagged pool: draw nothing in it, whatever the confidence. The pool key
      // is built exactly as node 21 builds it - the sub-part's FIRST character,
      // so "2d i" pools as "2d" - and true_false_correction splits one row into
      // an "a" judgment and a "b" correction via markAs rather than subPart.
      let poolSub = subPart ? String(subPart).trim().charAt(0) : '';
      if (exerciseType === 'true_false_correction') {
        poolSub = verdict.markAs === 'correction' ? 'b' : 'a';
      }
      const poolKey = String(fieldValue(row && row.exerciseNumber)) + poolSub;
      if (warnedPools.has(poolKey)) {
        skipped.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} (Aufgabe ${poolKey} is flagged for manual checking - no marks are drawn in it)`);
        continue;
      }

      // In case_identification antwort and fall hold the same answer, and
      // which of the two DocuPipe fills varies from paper to paper - one
      // paper had every case in 'antwort' with 'fall' empty. A verdict
      // naming the empty one is still about the filled one, so position it
      // there instead of dropping the mark.
      let posField = verdict.field;
      if (exerciseType === 'case_identification' && row && !hasBoxes(row[posField])) {
        const other = posField === 'fall' ? 'antwort' : 'fall';
        if (hasBoxes(row[other])) posField = other;
      }

      // A true/false CORRECTION is a different thing on the page from the
      // judgment it accompanies, and since wAoDOCxk the extraction says so:
      // richtigFalsch is boxed on the Richtig/Falsch checkbox (0.849-0.891 on
      // Kurztest A4) and studentAnswer on the correction word out in the
      // sentence (0.274-0.371). Node 24a maps 'antwort' to the JUDGMENT,
      // because that is what the judgment mark and buildJudgmentColumnMap both
      // need - so the correction verdict is the one case that wants the other
      // box, and it asks for it by name here.
      //
      // This is the workaround Nitai was asked to remove. He split the two
      // fields precisely so each could be boxed on its own; reading them back
      // apart is the whole point of the split.
      //
      // Falls through untouched when the row has no studentAnswer box: the
      // older schemas have no such field at all, and a "Richtig" row carries
      // no correction. In both cases the mark stays exactly where it was.
      // Where the student wrote NO correction there is no box to move to, and
      // the verdict falls back to the judgment's box - landing on top of the
      // judgment mark. Measured on Kurztest A4 row 5: judgment at 0.772 (the
      // learned Richtig column), correction at 0.764, about 4.8pt apart, just
      // outside the 4px collision nudge below. The verdict is real - "keine
      // Korrektur angegeben" costs the point - so it is placed one line under
      // the judgment rather than hidden or left overlapping it.
      let correctionWithoutOwnBox = false;
      if (exerciseType === 'true_false_correction' && verdict.markAs === 'correction') {
        if (row && hasBoxes(row.studentAnswer)) {
          posField = 'studentAnswer';
        } else {
          correctionWithoutOwnBox = true;
        }
      }

      const useHybridAnchor =
        (exerciseType === 'true_false_correction' && posField === 'antwort' && subPart !== 'b') ||
        (exerciseType === 'case_identification' && (posField === 'fall' || posField === 'antwort')) ||
        (exerciseType === 'preposition_only' && posField === 'antwort') ||
        // Blank and "Fall:" line sit on the sentence's own line. Taking the
        // row from the sentence keeps two rows with the same case ("Dativ",
        // boxed once for both) on their own lines.
        (exerciseType === 'fill_blank_with_case' && (posField === 'antwort' || posField === 'fall'));

      const frageField = row && row.frage;

      // ---- Change 24, 22.09.2026 ---------------------------------------
      // A mark that is not drawn leaves the page SILENT. The teacher cannot
      // tell "the pipeline declined to place this" from "this question was
      // never graded", and on Enea's Nachpruefung that happened to three
      // consecutive answers - 2a, 2b and 2c - while the score counted all
      // three. Measured across 319 marks on 22.09: 5 withheld this way.
      //
      // The rule being applied is Nitai's, and it is right: never draw on a
      // "low" coordinate, because a confident-looking mark in the wrong
      // place is worse than no mark. But it was written for a mark drawn ON
      // the item, where a wrong box puts the score on the wrong word.
      //
      // IN MARGIN MODE THAT DANGER DOES NOT EXIST. The mark goes in the
      // right margin at a fixed x; the box supplies only the ROW. So when
      // the answer's box is untrustworthy but the QUESTION's box on the same
      // line is not, the row is still known and the mark can be drawn. On
      // all five withheld marks the question's box was high or medium.
      //
      // IN GRAMMATIK the danger is real, so the refusal stands - but the
      // page no longer stays silent about it: the value is drawn in AMBER in
      // the right margin, on the row the question gives. The margin is ours
      // and unambiguous, and amber already means "look at this" everywhere
      // else in this file. She sees the score and that its placement was not
      // trusted, instead of seeing nothing.
      const gradedField = row && row[posField];
      const gradedUnusable = !hasBoxes(gradedField) || gradedField.review.confidence === 'low';
      let rowFromQuestion = false;   // margin mode: row borrowed, mark drawn normally
      let withheldToMargin = false;  // Grammatik: not placed on the item, shown in the margin

      // The graded field itself is "the" field: it's what the verdict is
      // about, so it decides confidence, page and rotation. The hybrid
      // anchor below only ever borrows frage's row position.
      let field = gradedField;

      // Swap in the question's box BEFORE gradedBox is read from it, so the
      // row below comes from the question and everything downstream follows
      // without knowing the difference.
      if (gradedUnusable && hasTrustedBoxes(frageField)) {
        const why = hasBoxes(gradedField) ? 'low confidence' : 'no box of its own';
        field = frageField;
        if (MARGIN_MODE) {
          rowFromQuestion = true;
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - the answer's box had ${why}; in margin mode the box supplies only the row, so the row was taken from this row's question instead`);
        } else {
          withheldToMargin = true;
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - the answer's box had ${why}, so the mark is NOT placed on the item; its value is drawn in amber in the right margin, on the row the question gives`);
        }
      }

      if (!hasBoxes(field)) {
        skipped.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field}`);
        continue;
      }

      // NEW: DocuPipe now reports a 'confidence' level ("high"/"medium"/
      // "low") alongside every field's coordinates, describing how sure it
      // is that the box actually sits on the cited word (per Nitai's Sep
      // 2026 update). Per his own recommendation: never draw on a "low"
      // coordinate at all (a wrong-but-confident-looking mark is worse than
      // no mark), draw "medium" but flag it visually so the teacher knows
      // to double check it, and treat missing/undefined confidence (older
      // documents processed before this field existed) the same as "high"
      // so nothing already working breaks.
      const confidence = field.review.confidence;
      if (confidence === 'low') {
        skipped.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} (low confidence coordinate - not trustworthy, skipped per Nitai's recommendation)`);
        continue;
      }

      const pageIndex = field.review.page - 1;
      const page = pages[pageIndex];
      if (!page) {
        skipped.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} (page ${field.review.page} not found - PDF only has ${pages.length} page(s))`);
        continue;
      }
      const { width, height } = page.getSize();
      const rotationAngle = page.getRotation().angle;

      // Combine coordinates at the NORMALIZED level (before the rotation
      // transform), not after - for 90/270-rotated pages, "row position"
      // does not map cleanly onto a single raw x or y axis, so mixing
      // already-converted raw coordinates would be wrong. Normalized
      // coordinates describe the page the way a human sees it regardless
      // of rotation (per toRawCoords' own contract above), so row
      // identity is always normalized y1, and column position is always
      // normalized x1 - safe to combine here, then convert once.
      const gradedBox = field.review.boundingBoxes[0];

      // One line of mark text, expressed in the same normalized units as the
      // boxes. Normalized Y maps onto the page's raw HEIGHT for an upright
      // page, but onto its WIDTH once the page carries a 90/270 rotate flag,
      // so the divisor follows the rotation.
      const lineHeightNorm = MARK_FONT_SIZE / ((rotationAngle === 90 || rotationAngle === 270) ? width : height);

      let x1 = gradedBox[0];                          // column position: the graded field's own left edge
      let y1 = rowAnchorY(gradedBox, lineHeightNorm);  // row position: first line of the field

      // A duplicated 'frage' box points at the wrong ROW, so a frage verdict
      // drawn against it lands on whichever row won the duplicate. The row's
      // own antwort and fall boxes are unique to it and carry the right
      // vertical position, so borrow one of those instead - only the row,
      // the column still comes from frage.
      if (verdict.field === 'frage' && duplicateFrageRows.has(verdict.answerIndex)) {
        const sibling = [row && row.antwort, row && row.fall].find(hasTrustedBoxes);
        if (sibling && sibling.review.page === field.review.page) {
          y1 = rowAnchorY(sibling.review.boundingBoxes[0], lineHeightNorm);
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field frage - frage box is shared with another row, so the row position was taken from this row's own answer instead`);
        }
      }

      // COLLAPSED BOX: the answer's box starts at exactly the same x as its
      // own sentence and ends before the sentence does - i.e. it spans
      // "sentence start .. end of the answer" rather than just the answer.
      // Seen on Aufgabe 6 rows 1 and 4, where the mark landed on "Ich"
      // instead of on the pronoun, at confidence "high".
      //
      // The right edge is still the end of the real answer, so anchoring
      // there and right-aligning the label puts the mark on the answer
      // instead of on the first word of the sentence. Requiring the box to
      // end BEFORE the sentence matters: where frage and antwort share one
      // identical box (Aufgabe 4 row 3) nothing can be inferred, and that
      // case is excluded rather than guessed at.
      let rightAlignMark = false;
      const frageBox = hasTrustedBoxes(frageField) ? frageField.review.boundingBoxes[0] : null;
      if (frageBox && frageBox.length >= 4 && gradedBox.length >= 4 &&
          Math.abs(gradedBox[0] - frageBox[0]) < COLLAPSE_START_TOLERANCE &&
          gradedBox[2] < frageBox[2] - 0.005) {
        x1 = gradedBox[2];
        rightAlignMark = true;
        positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - box collapsed onto the sentence start; mark anchored to the answer's right edge instead`);
      }

      // If this row's box was a duplicate of another row's, its column is
      // wrong - substitute the column learned from the uncollided rows of
      // the same exercise (see buildColumnRepairMap).
      // Never for a true/false CORRECTION: it is written under the wrong
      // word out in the sentence, not in a column, so its x legitimately
      // differs from every other row's - "repairing" it pulled the mark
      // into the Richtig column.
      const isCorrectionVerdict = exerciseType === 'true_false_correction' && verdict.markAs === 'correction';
      const repairedX = isCorrectionVerdict ? undefined : columnRepairs.get(`${verdict.answerIndex}:${posField}`);
      if (repairedX !== undefined) {
        x1 = repairedX;
        // A column repair supersedes the collapse handling: it gives an
        // absolute position learned from the other rows, so the label must
        // start there rather than be pulled back to end at a right edge we
        // are no longer using. Both can fire on the same box - a collapsed
        // box is also an outlier - and combining them would shift the mark
        // one label-width left of its column.
        rightAlignMark = false;
        positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - column repaired: DocuPipe returned a duplicate box for this value, X taken from the same column on uncollided lines`);
      }

      // 'markAs' (set by node 19z for true_false_correction) says which half
      // of a merged "Falsch, vom" answer this verdict is about:
      //   correction -> belongs on the correction word out in the sentence
      //   anything else -> the Richtig/Falsch judgment, which belongs in the
      //                    table column
      // The test is deliberately "is it a correction?" rather than "is it
      // exactly the string judgment?", mirroring node 21's own pooling rule.
      // A model that writes "judgement", or omits markAs on a row it merged
      // into one verdict, then still lands in the table instead of silently
      // reverting to the raw box position.
      // One verdict per answer inside a merged row (see buildMergedSplitMap).
      // Only applies when grading actually said which answer it is about;
      // a single verdict for the whole merged row keeps its old position.
      const partCount = countParts(fieldValue(field));
      if (Number.isInteger(verdict.part) && partCount > 1 && verdict.part < partCount) {
        const key = `${fieldValue(row && row.exerciseNumber)}|${posField}|${partCount}`;
        const split = mergedSplits.get(key) || { x1: gradedBox[0], w: gradedBox[2] - gradedBox[0] };
        x1 = split.x1 + (split.w * verdict.part) / partCount;
        rightAlignMark = false;
      }

      const isTrueFalse = exerciseType === 'true_false_correction';
      const isCorrectionMark = isTrueFalse && verdict.markAs === 'correction';

      // A correction verdict with no box of its own is placed just after the
      // sentence, on the judgment's row - see the branch below for why not in
      // the row's empty Richtig/Falsch cell.
      //
      // The first attempt pushed the mark one line DOWN instead, and measuring
      // it showed why that was wrong: the row pitch on A4 is 32.9pt and a line
      // is 18.1pt, so the mark ended up closer to the NEXT row's judgment
      // (15.6pt) than to its own (18.8pt) - it had simply moved the collision
      // rather than resolved it.
      let correctionPlacedBesideSentence = false;
      if (isTrueFalse && !isCorrectionMark) {
        const cols = judgmentColumns.get(String(fieldValue(row && row.exerciseNumber)));
        if (cols && cols.size) {
          const answerText = String(fieldValue(field) || '');
          const word = /^\s*falsch/i.test(answerText) ? 'falsch' : 'richtig';
          if (cols.has(word)) {
            x1 = cols.get(word);
          } else {
            // That column was never observed on this paper (e.g. every
            // "Falsch" row also carried a correction, so nothing was ever
            // boxed on the Falsch checkbox). Use the column we DID observe,
            // so the mark is at least inside the table, and say so.
            x1 = cols.values().next().value;
            positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - the "${word}" column never appears boxed on this paper; judgment mark placed in the observed judgment column instead`);
          }
        }
      } else if (isTrueFalse && correctionWithoutOwnBox) {
        // Just after the end of the sentence, in the band before the
        // Richtig/Falsch columns. Measured on A4 row 5: the sentence ends at
        // 0.569 and the first judgment column starts at 0.764, so there is a
        // clear strip of its own - and it is where the eye already looks for
        // corrections, because on the rows that DO carry one the mark sits out
        // in the sentence.
        //
        // NOT in the row's empty judgment cell, which is where this went
        // first: a number inside the Falsch box reads as a verdict ABOUT
        // Falsch, and it sits nowhere near the other corrections.
        const fb = hasTrustedBoxes(frageField) ? frageField.review.boundingBoxes[0] : null;
        if (fb && fb.length >= 4) {
          const sideways = rotationAngle === 90 || rotationAngle === 270;
          const visualW = sideways ? height : width;
          const cols = judgmentColumns.get(String(fieldValue(row && row.exerciseNumber)));
          const firstCol = (cols && cols.size) ? Math.min(...cols.values()) : 1;
          const candidate = fb[2] + 8 / visualW;
          // A long sentence could push the mark into the judgment column, so
          // only take the position if the strip is actually wide enough for
          // the label. Otherwise fall through to the line below.
          const labelNorm = (MARK_FONT_SIZE * 2.6) / visualW;
          if (candidate + labelNorm < firstCol) {
            x1 = candidate;
            rightAlignMark = false;
            correctionPlacedBesideSentence = true;
          }
        }
      }

      // Only borrow frage's row position if frage itself is trustworthy -
      // the same confidence rule applied to the graded field above. A
      // low-confidence frage box is exactly as likely to be in the wrong
      // place as the duplicate-text coordinate it's meant to replace.
      //
      // A correction with no box of its own is the exception among correction
      // marks: it is being placed against the judgment's row, so it wants the
      // judgment's row anchor too. Without this it sat 8pt off its own
      // judgment, because one took the row from frage and the other from
      // richtigFalsch's box.
      if (useHybridAnchor &&
          (!isCorrectionMark || correctionWithoutOwnBox) &&
          !duplicateFrageRows.has(verdict.answerIndex) &&
          hasTrustedBoxes(frageField) &&
          frageField.review.page === field.review.page) {
        y1 = rowAnchorY(frageField.review.boundingBoxes[0], lineHeightNorm); // row position from frage (unique per row); column (x1) stays from the graded field
      }

      // Every field is drawn at its own coordinate, overlapping that row's
      // own handwriting. That is deliberate: it's how a teacher marks a
      // paper, and it's what the antwort/fall columns already did well.
      // Earlier attempts to push the frage mark into an external margin or
      // to nudge it vertically both failed - this table spans nearly the
      // full page width (no real margin exists), and nudging only traded
      // one row's overlap for the row above's. Uniform treatment is both
      // simpler and correct.
      // CONTAINMENT - a mark must land on its own row.
      //
      // Because handwriting is absent from the page's text layer, the
      // extraction cites whatever printed text matches the value. One
      // "Falsch, dem" was therefore boxed onto the printed word "Falsch" in
      // the table header, a third of a page above its own sentence, at
      // confidence high. No column logic catches that - the column was fine,
      // the ROW was wrong.
      //
      // The row's frage says where the row is. A correction is written under
      // its sentence, so allow generous room below, but essentially none
      // above: nothing legitimately sits above the line it belongs to.
      if (frageBox && frageBox.length >= 4) {
        const above = frageBox[1] - CONTAINMENT_ABOVE;
        const below = frageBox[3] + CONTAINMENT_BELOW;
        if (y1 < above || y1 > below) {
          // A box that landed on another row is wrong in BOTH axes, not just
          // vertically: the one cited to the header carried that header
          // cell's x as well, so repairing only the row left the mark in the
          // Falsch column. Take the whole position from the sentence. That
          // is not where the correction is written - we have no coordinate
          // for that - but it is the right row and the right cell, which is
          // as far as the data honestly goes.
          // Exception: an answer or case box in the wrong row (Aufgabe 1b,
          // where "ihrem Freund" was boxed on "Freund?" one row up). Here
          // the field has its own column, so taking the sentence's x would
          // stack this mark on top of the frage mark. Start of its own
          // column on the correct row instead.
          const ownColumn = (!isTrueFalse && verdict.field !== 'frage')
            ? fieldColumnStart(answers, fieldValue(row && row.exerciseNumber), posField)
            : null;
          x1 = ownColumn !== null ? ownColumn : frageBox[0];
          y1 = rowAnchorY(frageBox, lineHeightNorm);
          rightAlignMark = false;
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - box sat outside its own row (probably cited to matching printed text elsewhere); position taken from the sentence instead`);
        }
      }

      // MARGIN MODE: discard the column the repair layer just worked out and
      // put the mark in the right margin instead, taking only the row from the
      // field''s own box - exactly what the Hoerverstehen build does.
      //
      // Deliberately placed AFTER the repair block rather than around it: the
      // block declares rightAlignMark and frageBox, which are read further
      // down, so wrapping it would scope them away. The cost is that repair
      // notes can still reach positionWarnings in margin mode; they are
      // informational, and this template returned no warnings at all before.
      if (MARGIN_MODE || withheldToMargin) {
        x1 = RIGHT_MARGIN_X_FRACTION;
        y1 = rowAnchorY(gradedBox, lineHeightNorm);
        rightAlignMark = true;   // the label must END at the margin, not start there
      }

      if (correctionWithoutOwnBox) {
        if (correctionPlacedBesideSentence) {
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - no correction was written, so this verdict has no box of its own; drawn just after the sentence, in the strip before the judgment columns`);
        } else {
          // Only one judgment column was ever observed on this paper, so
          // there is no empty cell to use. Fall back to a line below the
          // judgment - crowded, but on the right row and visible.
          y1 += lineHeightNorm;
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - no correction was written and only one judgment column is boxed on this paper; drawn one line under the judgment mark`);
        }
      }

      let { x: xPos, y: yTop } = toRawCoords(x1, y1, width, height, rotationAngle);

      // LAST-RESORT safety net: if this mark would land essentially on top
      // of the previously-drawn mark on this page, nudge it aside so it's
      // at least visible. This does NOT make the position correct - it only
      // stops one mark hiding completely behind another when the hybrid
      // anchor above couldn't separate them. Anything reported in
      // positionWarnings is a signal to investigate, not a fix.
      const COLLISION_THRESHOLD = 4; // px
      const lastPos = lastMarkPosByPage[pageIndex];
      if (lastPos && Math.abs(xPos - lastPos.x) < COLLISION_THRESHOLD && Math.abs(yTop - lastPos.y) < COLLISION_THRESHOLD) {
        ({ x: xPos, y: yTop } = nudgeVisualDown(xPos, yTop, 14, rotationAngle));
        positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - nudged: landed on top of the previous mark; this is a visibility fix only, not a confirmed correct position`);
      }
      lastMarkPosByPage[pageIndex] = { x: xPos, y: yTop };

      // Amber, not green/red: the value is right but its placement was not
      // trusted, and the colour has to say the second thing without denying
      // the first. Same amber as a warned subtotal and the manual-check note.
      const color = withheldToMargin
        ? rgb(0.85, 0.45, 0)
        : (verdict.isCorrect ? rgb(0, 0.6, 0) : rgb(0.8, 0, 0));
      const pointsLabel = (verdict.pointsPossible !== undefined && verdict.pointsPossible !== null)
        ? `${fmtPoints(verdict.pointsAwarded ?? 0)}/${fmtPoints(verdict.pointsPossible)}P`
        : (verdict.isCorrect ? 'OK' : 'X');

      // Comments are deliberately not drawn. A second line of small text
      // under every mark was the single biggest source of clutter: it
      // collided with the row below in tight tables and ran across into the
      // neighbouring column in multi-column exercises. The score and its
      // colour carry the verdict; the wording lives in the workflow output
      // if it's ever needed.
      // For a collapsed box the anchor is the answer's RIGHT edge, so the
      // label has to be shifted back by its own width to end there rather
      // than start there. The shift follows the text direction, so it stays
      // correct on a rotated page.
      if (rightAlignMark) {
        const w = markFont.widthOfTextAtSize(pointsLabel, markFontSize);
        const rad = (rotationAngle * Math.PI) / 180;
        xPos -= w * Math.cos(rad);
        yTop -= w * Math.sin(rad);
      }

      drawLabel(page, pointsLabel, xPos, yTop, markFontSize, color, rotationAngle, markFont);


      annotatedCount++;
      if (withheldToMargin) {
        marginWithheld.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} (${pointsLabel})`);
      } else if (rowFromQuestion) {
        rowRecovered.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} (${pointsLabel})`);
      }
    }

    // Draw a per-sub-part subtotal (e.g. "3.5P / 5.0P") near the first row
    // of that sub-part, approximating "next to the exercise/sub-part title"
    // since we don't have a dedicated title-coordinate field - the first
    // matching answer row is the closest reliable anchor we have.
    //
    // GRAMMATIK ONLY. Subtotals are drawn at SUBTOTAL_LEFT_INSET - the LEFT
    // page edge - while margin mode puts every per-row mark at the RIGHT edge.
    // On Hoerverstehen that produced two competing columns of numbers on
    // opposite sides of the same page, which is how it was reported from the
    // first annotated paper (21.09.2026). The Hoerverstehen template never drew
    // subtotals; the merge gave it the grammar build's subtotal block along
    // with everything else, and this is that half being switched back off.
    //
    // The workflow still COMPUTES them - 19merge and node 21 are untouched, so
    // they stay in the execution output. Only the drawing stops.
    // Margin mode draws no subtotals — except a flagged one, which is the only
    // thing left on that exercise once its marks are suppressed. Without it a
    // Hoerverstehen paper would show an exercise with nothing at all on it and
    // no way to tell that from "nothing to say".
    const subtotalsDrawnPerRow = {};
    if (Array.isArray(subtotals)) {
      for (const sub of subtotals) {
        // Margin mode draws no subtotals except the ones carrying a warning -
        // including a blank task's settled zero, which has no verdict and so
        // no mark of its own. Without it, "nothing written" and "nothing to
        // say" look identical on the page.
        if (MARGIN_MODE && !sub.warning) continue;
        // sub.key looks like "1a", "1b", or just "2" (no sub-part letter).
        const match = String(sub.key).match(/^(\d+)([a-zA-Z]?)$/);
        if (!match) continue;
        const [, exNumStr, subPartLetter] = match;
        const exNum = parseInt(exNumStr, 10);

        const matchesExercise = (a) => String(fieldValue(a.exerciseNumber)) === String(exNum);
        let firstRowIndex = answers.findIndex(a => {
          if (!matchesExercise(a)) return false;
          const rowSubPart = fieldValue(a.subPart);
          if (subPartLetter === 'a') return rowSubPart === 'a' || !rowSubPart; // null/undefined subPart defaults to 'a' by convention (matches node 21 and the true_false_correction template)
          if (subPartLetter) return rowSubPart === subPartLetter;
          return !rowSubPart; // no letter in key means match rows with no subPart
        });

        // No row carries this sub-part letter at all. That is normal rather
        // than broken: in true_false_correction the schema emits one row per
        // sentence with subPart null, and node 19z splits each into an "a"
        // judgment and a "b" correction - so pool "5b" has real points but
        // no row of its own to sit beside. Anchor it to the exercise's rows
        // anyway, otherwise a whole sub-part's score silently never appears.
        const poolHasOwnRow = firstRowIndex !== -1;
        if (!poolHasOwnRow) {
          firstRowIndex = answers.findIndex(matchesExercise);
        }
        if (firstRowIndex === -1) continue;

        const row = answers[firstRowIndex];
        // Pick the first field that is actually USABLE, not merely present.
        // `row.frage || row.antwort || row.fall` looked like a fallback
        // chain but was not: frage is a truthy object even when its
        // boundingBoxes are null, so it always won and the subtotal was
        // then dropped entirely, even though antwort/fall had perfectly
        // good coordinates sitting right there.
        // Prefer any row of the exercise with a position, not just the first.
        let anchorField = [row.frage, row.antwort, row.fall].find(hasTrustedBoxes);
        if (!anchorField) {
          const other = answers.find(a => a && matchesExercise(a) && [a.frage, a.antwort, a.fall].some(hasTrustedBoxes));
          if (other) anchorField = [other.frage, other.antwort, other.fall].find(hasTrustedBoxes);
        }

        // No row of the exercise has a position at all (Aufgabe 3 on one
        // paper: the whole text came back as a single unlocated row). Its
        // subtotal - and the warning under it, which matters most exactly
        // then - was silently dropped. Place it in the gap between the
        // previous exercise's last located box and the next exercise's first,
        // which is where the exercise sits on the page.
        const boxesOf = (a) => [a.frage, a.antwort, a.fall].filter(hasTrustedBoxes);
        const lowestOf = (bs) => bs.reduce((lo, f) => (f.review.boundingBoxes[0][3] > lo.review.boundingBoxes[0][3] ? f : lo));
        const topmostOf = (bs) => bs.reduce((hi, f) => (f.review.boundingBoxes[0][1] < hi.review.boundingBoxes[0][1] ? f : hi));

        let anchorBox;
        let anchorPage;

        // A POOL WITH NO ROW OF ITS OWN must not borrow a sibling pool's row.
        // A task left completely blank gives the extraction nothing, so pool
        // "3a" falls back to "any row of exercise 3" - and on Kerim's paper
        // that is 3b, which put 3a's zero at y 0.402, right beside 3b's answer
        // and a whole task below where it belongs.
        //
        // The blank answer lines sit between the last located row BEFORE the
        // exercise and the exercise's own first row, so the zero goes there:
        // measured on Kerim, between 2d iii ending at 0.175 and 3b's question
        // starting at 0.385.
        if (!poolHasOwnRow) {
          const exFirst = answers.findIndex(matchesExercise);
          let next = null;
          if (exFirst !== -1 && answers[exFirst]) {
            const bs = boxesOf(answers[exFirst]);
            if (bs.length) next = topmostOf(bs);
          }
          let prev = null;
          for (let k = exFirst - 1; k >= 0 && !prev; k--) {
            const bs = answers[k] ? boxesOf(answers[k]) : [];
            if (bs.length) prev = lowestOf(bs);
          }
          if (next && prev && prev.review.page === next.review.page) {
            anchorPage = next.review.page;
            const y = Math.min(prev.review.boundingBoxes[0][3] + 0.05, next.review.boundingBoxes[0][1] - 0.03);
            anchorBox = [0, y, 0, y];
          } else if (next) {
            // The previous row is on another page, so there is nothing to
            // measure the gap from - sit just above the exercise's own start.
            anchorPage = next.review.page;
            const y = Math.max(0, next.review.boundingBoxes[0][1] - 0.06);
            anchorBox = [0, y, 0, y];
          }
        }

        if (anchorBox) {
          // already placed by the blank-pool branch above
        } else if (anchorField) {
          anchorBox = anchorField.review.boundingBoxes[0];
          anchorPage = anchorField.review.page;
        } else {
          let prev = null;
          for (let k = firstRowIndex - 1; k >= 0 && !prev; k--) {
            const bs = answers[k] ? boxesOf(answers[k]) : [];
            if (bs.length) prev = bs.reduce((lo, f) => (f.review.boundingBoxes[0][3] > lo.review.boundingBoxes[0][3] ? f : lo));
          }
          let next = null;
          for (let k = firstRowIndex + 1; k < answers.length && !next; k++) {
            if (!answers[k] || matchesExercise(answers[k])) continue;
            const bs = boxesOf(answers[k]);
            if (bs.length) next = bs.reduce((hi, f) => (f.review.boundingBoxes[0][1] < hi.review.boundingBoxes[0][1] ? f : hi));
          }
          if (prev && next && prev.review.page === next.review.page) {
            // Just below the previous exercise - where this exercise's own
            // heading is printed - but never past the next exercise.
            anchorPage = prev.review.page;
            const y = Math.min(prev.review.boundingBoxes[0][3] + 0.05, next.review.boundingBoxes[0][1] - 0.03);
            anchorBox = [0, y, 0, y];
          } else if (prev) {
            anchorPage = prev.review.page;
            const y = prev.review.boundingBoxes[0][3] + 0.04;
            anchorBox = [0, y, 0, y];
          } else if (next) {
            anchorPage = next.review.page;
            const y = Math.max(0, next.review.boundingBoxes[0][1] - 0.04);
            anchorBox = [0, y, 0, y];
          } else {
            continue;
          }
        }

        const page = pages[anchorPage - 1];
        if (!page) continue;

        const { width, height } = page.getSize();
        const rotationAngle = page.getRotation().angle;
        const lineHeightNorm = SUBTOTAL_FONT_SIZE / ((rotationAngle === 90 || rotationAngle === 270) ? width : height);

        // Same compact form as the individual marks ("3.13/5P" rather than
        // "3.13P / 5P"): it reads consistently, and the shorter string is
        // what lets the label fit in the page's left margin below.
        const subtotalText = `${fmtPoints(sub.awarded)}/${fmtPoints(sub.possible)}P`;

        // Subtotals sit at a FIXED inset from the page's left edge.
        //
        // Inferring the margin from the fields does not work here. In a
        // table with a leading "Nr." column, nothing in that column is an
        // extracted field, so the leftmost field is the sentence in the
        // SECOND column and the label lands on the row numbers. Widening the
        // measurement to the whole page does not help either: on the page
        // holding Aufgabe 5 and 6, every single field starts to the right of
        // the table border, so the border is simply not visible in the data.
        //
        // A fixed inset needs no inference. Printed content on these pages
        // begins around 44pt, so a label starting at 2pt clears it, and all
        // subtotals line up in one column down the edge. The inset is given
        // in points and converted through the usual transform, so it stays
        // at the visual left edge on a rotated page too.
        const anchorY = rowAnchorY(anchorBox, lineHeightNorm);
        const sideways = rotationAngle === 90 || rotationAngle === 270;
        const visualW = sideways ? height : width;
        // In margin mode the flagged subtotal goes where that template's marks
        // go — the right margin — rather than reintroducing a left-hand column
        // the Hoerverstehen paper has never had.
        const xNorm = MARGIN_MODE ? RIGHT_MARGIN_X_FRACTION : (SUBTOTAL_LEFT_INSET / visualW);
        const pos = toRawCoords(xNorm, anchorY, width, height, rotationAngle);
        let subX = pos.x;
        let subY = pos.y;
        if (MARGIN_MODE) {
          // right-aligned, so the label ends at the margin
          const w = labelFontBold.widthOfTextAtSize(subtotalText, SUBTOTAL_FONT_SIZE);
          const rad = (rotationAngle * Math.PI) / 180;
          subX -= w * Math.cos(rad);
          subY -= w * Math.sin(rad);
        }

        // Two sub-parts can now share one anchor row (see the fallback
        // above), which would stack "2.5P / 3P" and "3P / 3P" on the exact
        // same spot. Offset each additional subtotal on a given row so both
        // stay readable.
        const stackIndex = subtotalsDrawnPerRow[firstRowIndex] || 0;
        subtotalsDrawnPerRow[firstRowIndex] = stackIndex + 1;
        if (stackIndex > 0) {
          ({ x: subX, y: subY } = nudgeVisualDown(subX, subY, stackIndex * (SUBTOTAL_FONT_SIZE + 4), rotationAngle));
        }

        // A warning used to be drawn as a second line under the subtotal, in
        // amber. On the page that reads as TWO subtotals for one exercise -
        // one blue, one amber - which is exactly the wrong signal.
        //
        // The warning is now carried by the subtotal's own COLOUR: amber
        // instead of blue, and no second line. Amber rather than red, since it
        // says "look at this yourself", not "wrong". The teacher's instruction,
        // 21.09.2026: one number per exercise, and its colour tells her whether
        // the exercise needs her own eyes.
        //
        // The text of the warning stays in the execution output and in
        // positionWarnings; only the drawing of it stops.
        // Amber only where the teacher has to look. A blank task carries a
        // warning too, but it is a settled zero — it stays blue.
        const subtotalColor = warnedPools.has(String(sub.key)) ? rgb(0.85, 0.45, 0) : rgb(0, 0, 0.6);
        drawLabel(page, subtotalText, subX, subY, SUBTOTAL_FONT_SIZE, subtotalColor, rotationAngle, labelFontBold);
      }
    }

    // Swiss grade as calculated by Escola:
    //   Note = (erreichte Punkte + Bonuspunkte) / maximale Punkte * 5 + 1
    // rounded to the step the teacher picked in the form (0.1 = Zehntel,
    // 0.5 = halbe Noten). Without those fields: step 0.5, no bonus.
    //
    // Ported from the deployed build 21.09.2026. This file had the step
    // hardcoded to 0.5, which is why deploying it would have broken the
    // tenths the teacher grades in - she writes 4.6 on a Kurztest, and
    // 31/43 is exactly 1 + 5 * (31/43).
    const GRADE_STEP = Number(gradeRounding) > 0 ? Number(gradeRounding) : 0.5;
    const BONUS_POINTS = Number(bonusPoints) || 0;

    function computeSwissGrade(awarded, possible) {
      if (!possible) return null;
      const raw = 1 + 5 * ((Number(awarded) + BONUS_POINTS) / possible);
      const rounded = Math.round(raw / GRADE_STEP) * GRADE_STEP;
      return Math.max(1, Math.min(6, rounded));
    }

    // As many decimals as the step needs, at least one: 5.3 / 5.0 / 5.25.
    function formatGrade(g) {
      const stepDecimals = (String(GRADE_STEP).split('.')[1] || '').length;
      return Number(g).toFixed(Math.max(1, stepDecimals));
    }

    // Place the total score and computed grade at the ACTUAL 'Punkte'/'Note'
    // field locations from the schema, if they exist with their own
    // coordinates - falling back to a corner of the last page otherwise.
    if (totalPointsAwarded !== undefined && totalPointsPossible !== undefined) {
      const swissGrade = computeSwissGrade(totalPointsAwarded, totalPointsPossible);
      const scoreText = `${fmtPoints(totalPointsAwarded)}P / ${fmtPoints(totalPointsPossible)}P`;
      const gradeText = swissGrade !== null ? formatGrade(swissGrade) : ''; // decimals follow GRADE_STEP

      // FIELD NAMES PER SCHEMA. Each schema names these differently, and a
      // name missing from this list is not an error anywhere - the field is
      // simply never found and that half of the header is silently not drawn.
      // Measured 21.09.2026, one half missing on each exam type:
      //   Hoerverstehen  totalPoints / maxPoints / grade
      //   wAoDOCxk       pointsAchieved / pointsMax / expectedGrade / finalGrade
      // 'pointsAchieved' and 'pointsMax' were in neither list, which is why
      // the Grammatik header showed a grade and no score at all.
      const punkteField = reviewData.totalScore || reviewData.totalPoints || reviewData.pointsAchieved || reviewData.Punkte || reviewData.punkte;
      const maxScoreField = reviewData.maxScore || reviewData.maxPoints || reviewData.pointsMax;

      // The score's own row, used to put the grade on the same line. Either
      // field will do - they sit side by side in the header - so take whichever
      // has a trustworthy box.
      const headerRowField = hasTrustedBoxes(punkteField) ? punkteField
                           : (hasTrustedBoxes(maxScoreField) ? maxScoreField : null);

      // Returning false on an untrustworthy coordinate is what makes the
      // fallback tiers below actually work. This guards against the exact
      // failure seen on the other exam template, where a header field
      // reported a coordinate that pointed at the instructions paragraph
      // instead of the header box - a wrong coordinate cannot be nudged
      // into a right one, so the only safe move is to decline it and let
      // the next tier try.
      function drawAtField(field, text, yNudge) {
        if (!hasTrustedBoxes(field)) return false;
        const page = pages[field.review.page - 1];
        if (!page) return false;
        const { width, height } = page.getSize();
        const rotationAngle = page.getRotation().angle;
        const [x1, y1] = field.review.boundingBoxes[0];
        const { x, y } = toRawCoords(x1, y1, width, height, rotationAngle);
        drawLabel(page, text, x, y + (yNudge || 0), HEADER_FONT_SIZE, rgb(0, 0, 0.7), rotationAngle, labelFontBold);
        return true;
      }

      // THE GRADE GOES IN THE RIGHT MARGIN, on the score's row, on every exam
      // type - and it is the largest thing on the page, because it is the one
      // number the student looks for.
      //
      // It used to be drawn beside whichever field the schema calls the final
      // grade. On the Kurztest that box sits at x 0.517 and the mark landed at
      // ~0.571, right next to "Erwartete Note" at 0.579 - the student's OWN
      // self-assessment, which has nothing to do with our grade. Anchoring to
      // a schema field means inheriting whatever the form happens to label
      // there; the right margin is ours, is unambiguous, and is where the
      // Hoerverstehen marks already live.
      //
      // Right-aligned, so the label ENDS at the margin rather than running off
      // the page edge.
      function drawInMargin(field, text, size, color) {
        if (!text) return false;
        if (!hasTrustedBoxes(field)) return false;
        const page = pages[field.review.page - 1];
        if (!page) return false;
        const { width, height } = page.getSize();
        const rotationAngle = page.getRotation().angle;
        const [, y1, , y2] = field.review.boundingBoxes[0];
        const sideways = rotationAngle === 90 || rotationAngle === 270;
        const visualH = sideways ? width : height;
        const baselineNorm = (y1 + y2) / 2 + (0.35 * size) / visualH;
        let { x, y } = toRawCoords(RIGHT_MARGIN_X_FRACTION, baselineNorm, width, height, rotationAngle);
        const w = labelFontBold.widthOfTextAtSize(text, size);
        const rad = (rotationAngle * Math.PI) / 180;
        x -= w * Math.cos(rad);
        y -= w * Math.sin(rad);
        drawLabel(page, text, x, y, size, color, rotationAngle, labelFontBold);
        return true;
      }

      // A flagged exercise means the total and the grade are arithmetic over
      // something that still has to be counted, so neither is drawn. The note
      // takes the grade's place: right-aligned at the margin, where it grows
      // leftward across the empty half of the header instead of off the page.
      if (manualCheckPools.length) {
        // A flagged pool means the total and the grade would be arithmetic over
        // something that still has to be counted, so NEITHER is drawn.
        //
        // The note sits ABOVE the header rather than in it. Put on the score's
        // own row it covered the printed "Punkte:" and "Note:" labels it is
        // there to explain; at NOTE_TOP_Y it clears every field the schema
        // reports (the highest is the student's name at y 0.116 on both exam
        // types). Right-aligned at the margin, like the grade it replaces.
        const noteText = `Aufgabe${manualCheckPools.length > 1 ? 'n' : ''} ${manualCheckPools.join(', ')} manuell prüfen`;
        const page = pages[0];
        if (page) {
          const { width, height } = page.getSize();
          const rotationAngle = page.getRotation().angle;
          let { x, y } = toRawCoords(RIGHT_MARGIN_X_FRACTION, NOTE_TOP_Y, width, height, rotationAngle);
          const w = labelFontBold.widthOfTextAtSize(noteText, SUBTOTAL_FONT_SIZE);
          const rad = (rotationAngle * Math.PI) / 180;
          x -= w * Math.cos(rad);
          y -= w * Math.sin(rad);
          drawLabel(page, noteText, x, y, SUBTOTAL_FONT_SIZE, rgb(0.85, 0.45, 0), rotationAngle, labelFontBold);
        }
      } else {
        const punkteDrawn = drawAtField(punkteField, scoreText, 0);
        const noteDrawn = drawInMargin(headerRowField, gradeText, GRADE_FONT_SIZE, rgb(0, 0, 0.7));

        // Fallback tier 2: blank fields (totalScore/finalGrade) often have no
        // OCR'd content yet, so Review may not report coordinates for them.
        // Try anchoring near known-good fields instead (maxScore/expectedGrade
        // DO have real values already, so they likely have real coordinates).
        // Nudge down slightly (-8) since these anchor fields' own boxes likely
        // represent the TOP of their text, while drawText positions by
        // baseline - using the raw coordinate directly renders noticeably
        // higher than the original text visually sat.
        let anchorFallbackUsed = false;
        if (!punkteDrawn) {
          // Carry the grade here only if the margin placement found no row at
          // all - otherwise one number in the header is better than none.
          const text = (!noteDrawn && gradeText) ? `${scoreText}   Note ${gradeText}  ` : scoreText + '  ';
          anchorFallbackUsed = drawAtField(maxScoreField, text, -8);
        }

        // Fallback tier 3 (last resort): corner of the last page, so the
        // total is never silently lost even if no anchor fields exist.
        if (!punkteDrawn && !noteDrawn && !anchorFallbackUsed) {
          const lastPage = pages[pages.length - 1];
          const lastPageRotation = lastPage.getRotation().angle;
          const { x, y } = toRawCoords(0.05, 0.95, lastPage.getWidth(), lastPage.getHeight(), lastPageRotation);
          drawLabel(lastPage, `Total: ${scoreText}${gradeText ? ' - Grade: ' + gradeText : ''}`, x, y, HEADER_FONT_SIZE, rgb(0, 0, 0), lastPageRotation, labelFontBold);
        }
      }
    }

    const outBytes = await pdfDoc.save();

    res.json({
      annotatedPdfBase64: Buffer.from(outBytes).toString('base64'),
      annotatedCount,
      skipped,
      positionWarnings,
      pdfPageCount: pages.length,
      // Point pools left unmarked on purpose, for the workflow to surface.
      // Non-empty means no total and no grade were drawn either.
      manualCheckPools,
      // Marks whose placement was degraded rather than refused outright.
      marginWithheld,
      rowRecovered
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------------------------------------
// POST /merge - put a cohort's annotated papers back into one PDF
//
// WHY THIS EXISTS
// The teacher has started handing over ONE scan containing every student's
// paper instead of one file per student. The pipeline grades one student per
// run - the extraction schema has a single studentName and one set of answers
// - so the scan is split before it reaches DocuPipe, and each paper comes back
// annotated on its own. She should get back what she sent: one marked-up file,
// in her original page order.
//
// The splitting happens on the caller's side and needs no PDF library, because
// a page tree is just an object listing pages and a subset of it can be written
// as an incremental update. Merging cannot be done that way - it means copying
// objects between documents, which is exactly what pdf-lib already does here.
//
// SHAPE
//   in : { pdfs: [ "<base64>", "<base64>", ... ] }   ORDER IS THE PAGE ORDER
//   out: { mergedPdfBase64, pageCount, sources, pagesPerSource }
//
// WHAT IS PRESERVED: copyPages carries each page's /Rotate and MediaBox with
// it. That matters more here than it looks - every coordinate this service
// draws with is measured against them, and the scans arrive rotated 90 or 270.
//
// A USEFUL SIDE EFFECT: the split files each carry the whole original document,
// with the other students' pages left in as unreferenced orphans. copyPages
// takes only the pages that are actually in the tree, so the merged file is
// clean and roughly the size of the original rather than N times it.
//
// FAILS LOUDLY, BY INDEX. A cohort merge that silently drops or reorders a
// paper would hand the teacher a plausible-looking document with someone's
// exam missing - the same shape of silent, total failure as the swapped form
// files of execution 375 and the hand-edited schema id before Change 3.
app.post('/merge', async (req, res) => {
  try {
    const parts = req.body && req.body.pdfs;

    if (!Array.isArray(parts)) {
      return res.status(400).json({ error: 'Body must be { pdfs: [ base64, ... ] } - "pdfs" was not an array.' });
    }
    if (parts.length === 0) {
      return res.status(400).json({ error: '"pdfs" is empty - nothing to merge.' });
    }
    for (let i = 0; i < parts.length; i++) {
      if (typeof parts[i] !== 'string' || parts[i].length === 0) {
        return res.status(400).json({ error: `pdfs[${i}] is not a non-empty base64 string.` });
      }
    }

    const merged = await PDFDocument.create();
    const pagesPerSource = [];

    for (let i = 0; i < parts.length; i++) {
      let source;
      try {
        source = await PDFDocument.load(Buffer.from(parts[i], 'base64'));
      } catch (err) {
        // Name the input rather than the symptom: with twenty papers in the
        // body, "Invalid PDF structure" on its own says nothing about which.
        return res.status(400).json({
          error: `pdfs[${i}] could not be read as a PDF: ${err.message}`,
          failedIndex: i
        });
      }

      const indices = source.getPageIndices();
      if (indices.length === 0) {
        return res.status(400).json({ error: `pdfs[${i}] has no pages.`, failedIndex: i });
      }

      const copied = await merged.copyPages(source, indices);
      copied.forEach(page => merged.addPage(page));
      pagesPerSource.push(indices.length);
    }

    const bytes = await merged.save();
    const pageCount = merged.getPageCount();

    // The count is the caller's cross-check: it should equal the page count of
    // the scan that was split, and a mismatch means a paper was lost on the way
    // through. Cheap to compute here, impossible to notice by looking.
    const expected = pagesPerSource.reduce((a, b) => a + b, 0);
    if (pageCount !== expected) {
      return res.status(500).json({ error: `merged ${pageCount} pages but the sources hold ${expected}.` });
    }

    res.json({
      mergedPdfBase64: Buffer.from(bytes).toString('base64'),
      pageCount,
      sources: parts.length,
      pagesPerSource
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF annotation service listening on port ${PORT}`);
});
