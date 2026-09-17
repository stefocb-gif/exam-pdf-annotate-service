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

// Per-exercise subtotals are drawn larger and bold so they read as a
// summary line rather than as just another per-answer mark.
const SUBTOTAL_FONT_SIZE = 12;

// The header total and final grade are drawn at the same weight and size as
// the subtotals, so the three summary numbers on the page read as one set.
const HEADER_FONT_SIZE = 12;

// Row-count warnings sit under their subtotal and must not compete with it
// for attention, so they are drawn smaller.
const WARNING_FONT_SIZE = 8;

// Distance in points from the page's left edge at which subtotals are drawn.
const SUBTOTAL_LEFT_INSET = 2;

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
// The result is marked confidence "medium", so the mark is drawn with the
// dashed "please check" outline rather than looking fully confirmed.
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
      warnings.push(`answerIndex ${i}, field frage - DocuPipe gave no position for this question; row position inferred from this row's own answer boxes (marked for checking)`);
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

function countParts(v) {
  if (typeof v !== 'string' || !v.includes(',')) return 1;
  return v.split(',').filter(t => t.trim()).length;
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

function nudgeVisualDown(x, y, distance, rotationAngle) {
  switch (rotationAngle) {
    case 270: return { x: x - distance, y };
    case 90:  return { x: x + distance, y };
    case 180: return { x, y: y + distance };
    default:  return { x, y: y - distance };
  }
}

app.get('/', (req, res) => {
  res.send('PDF annotation service is running. POST to /annotate.');
});

app.post('/annotate', async (req, res) => {
  try {
    const { pdfBase64, reviewData, verdicts, totalPointsAwarded, totalPointsPossible, subtotals } = req.body;

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
    const positionWarnings = [];
    const lastMarkPosByPage = {};

    // Verdicts now target a SPECIFIC field (frage/antwort/fall) per row,
    // one verdict per gradable part rather than one per whole row.
    // Shallow copy per row: inferMissingFrageBoxes replaces a row's 'frage'
    // object, and that must never leak back into the caller's data.
    const answers = (reviewData.answers || []).map(r => (r ? { ...r } : r));
    inferMissingFrageBoxes(answers, positionWarnings);
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
      const useHybridAnchor =
        (exerciseType === 'true_false_correction' && verdict.field === 'antwort' && subPart !== 'b') ||
        (exerciseType === 'case_identification' && verdict.field === 'fall') ||
        (exerciseType === 'preposition_only' && verdict.field === 'antwort');

      const frageField = row && row.frage;

      // The graded field itself is "the" field: it's what the verdict is
      // about, so it decides confidence, page and rotation. The hybrid
      // anchor below only ever borrows frage's row position.
      const field = row && row[verdict.field];

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
      let isMediumConfidence = confidence === 'medium';

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
      const repairedX = columnRepairs.get(`${verdict.answerIndex}:${verdict.field}`);
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
        const key = `${fieldValue(row && row.exerciseNumber)}|${verdict.field}|${partCount}`;
        const split = mergedSplits.get(key) || { x1: gradedBox[0], w: gradedBox[2] - gradedBox[0] };
        x1 = split.x1 + (split.w * verdict.part) / partCount;
        rightAlignMark = false;
      }

      const isTrueFalse = exerciseType === 'true_false_correction';
      const isCorrectionMark = isTrueFalse && verdict.markAs === 'correction';

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
      }

      // Only borrow frage's row position if frage itself is trustworthy -
      // the same confidence rule applied to the graded field above. A
      // low-confidence frage box is exactly as likely to be in the wrong
      // place as the duplicate-text coordinate it's meant to replace.
      if (useHybridAnchor &&
          !isCorrectionMark &&
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
            ? fieldColumnStart(answers, fieldValue(row && row.exerciseNumber), verdict.field)
            : null;
          x1 = ownColumn !== null ? ownColumn : frageBox[0];
          y1 = rowAnchorY(frageBox, lineHeightNorm);
          rightAlignMark = false;
          isMediumConfidence = true; // repaired position - flag for checking
          positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - box sat outside its own row (probably cited to matching printed text elsewhere); position taken from the sentence instead`);
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

      const color = verdict.isCorrect ? rgb(0, 0.6, 0) : rgb(0.8, 0, 0);
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
        const w = labelFont.widthOfTextAtSize(pointsLabel, MARK_FONT_SIZE);
        const rad = (rotationAngle * Math.PI) / 180;
        xPos -= w * Math.cos(rad);
        yTop -= w * Math.sin(rad);
      }

      const labelWidth = drawLabel(page, pointsLabel, xPos, yTop, MARK_FONT_SIZE, color, rotationAngle);

      // Medium confidence: the box was placed on the cited text, but that
      // text didn't read back the same as the extracted value (per Nitai -
      // often an OCR/handwriting mismatch, or the model itself was unsure).
      // The location is usually right, just not confirmed - outline the mark
      // so a teacher knows to double-check this one, without hiding it
      // entirely like "low" does. Drawn after the label so the outline sits
      // on top of the highlight rather than under it.
      if (isMediumConfidence) {
        page.drawRectangle({
          x: xPos - 3,
          y: yTop - 0.28 * MARK_FONT_SIZE,
          width: labelWidth + 6,
          height: MARK_FONT_SIZE * 1.3,
          borderColor: rgb(0.95, 0.6, 0),
          borderWidth: 1.2,
          borderDashArray: [3, 2],
          rotate: degrees(rotationAngle)
        });
      }

      annotatedCount++;
    }

    // Draw a per-sub-part subtotal (e.g. "3.5P / 5.0P") near the first row
    // of that sub-part, approximating "next to the exercise/sub-part title"
    // since we don't have a dedicated title-coordinate field - the first
    // matching answer row is the closest reliable anchor we have.
    const subtotalsDrawnPerRow = {};
    if (Array.isArray(subtotals)) {
      for (const sub of subtotals) {
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
        if (firstRowIndex === -1) {
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
        const anchorField = [row.frage, row.antwort, row.fall].find(hasTrustedBoxes);
        if (!anchorField) continue;

        const page = pages[anchorField.review.page - 1];
        if (!page) continue;

        const { width, height } = page.getSize();
        const rotationAngle = page.getRotation().angle;
        const anchorBox = anchorField.review.boundingBoxes[0];
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
        const insetNorm = SUBTOTAL_LEFT_INSET / ((rotationAngle === 90 || rotationAngle === 270) ? height : width);
        const pos = toRawCoords(insetNorm, anchorY, width, height, rotationAngle);
        let subX = pos.x;
        let subY = pos.y;

        // Two sub-parts can now share one anchor row (see the fallback
        // above), which would stack "2.5P / 3P" and "3P / 3P" on the exact
        // same spot. Offset each additional subtotal on a given row so both
        // stay readable.
        const stackIndex = subtotalsDrawnPerRow[firstRowIndex] || 0;
        subtotalsDrawnPerRow[firstRowIndex] = stackIndex + 1;
        if (stackIndex > 0) {
          ({ x: subX, y: subY } = nudgeVisualDown(subX, subY, stackIndex * (SUBTOTAL_FONT_SIZE + 4), rotationAngle));
        }

        drawLabel(page, subtotalText, subX, subY, SUBTOTAL_FONT_SIZE, rgb(0, 0, 0.6), rotationAngle, labelFontBold);

        // Row-count warning from node 21: the extraction returned fewer rows
        // for this exercise than the reference has, which means some of the
        // student's answers were never graded at all. That makes the score
        // itself wrong rather than just the annotation, so it has to be
        // visible on the page - a missing answer leaves no other trace.
        // Amber rather than red, since it flags "check this", not "wrong".
        if (sub.warning) {
          const warnPos = nudgeVisualDown(subX, subY, SUBTOTAL_FONT_SIZE + 2, rotationAngle);
          drawLabel(page, sub.warning, warnPos.x, warnPos.y, WARNING_FONT_SIZE, rgb(0.85, 0.45, 0), rotationAngle, labelFontBold);
        }
      }
    }

    // Compute a Swiss grade (1-6 scale) from the totals, rounded to the
    // nearest 0.5 - standard Swiss school convention.
    function computeSwissGrade(awarded, possible) {
      if (!possible) return null;
      const raw = 1 + 5 * (awarded / possible);
      const rounded = Math.round(raw * 2) / 2;
      return Math.max(1, Math.min(6, rounded));
    }

    // Place the total score and computed grade at the ACTUAL 'Punkte'/'Note'
    // field locations from the schema, if they exist with their own
    // coordinates - falling back to a corner of the last page otherwise.
    if (totalPointsAwarded !== undefined && totalPointsPossible !== undefined) {
      const swissGrade = computeSwissGrade(totalPointsAwarded, totalPointsPossible);
      const scoreText = `${fmtPoints(totalPointsAwarded)}P / ${fmtPoints(totalPointsPossible)}P`;
      const gradeText = swissGrade !== null ? `${swissGrade}` : '';

      const punkteField = reviewData.totalScore || reviewData.totalPoints || reviewData.Punkte || reviewData.punkte;
      const noteField = reviewData.finalGrade || reviewData.grade || reviewData.Note || reviewData.note;

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

      const punkteDrawn = drawAtField(punkteField, scoreText, 0);
      const noteDrawn = drawAtField(noteField, gradeText, 0);

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
        const maxScoreField = reviewData.maxScore || reviewData.maxPoints;
        anchorFallbackUsed = drawAtField(maxScoreField, scoreText + '  ', -8);
      }
      if (!noteDrawn) {
        const expectedGradeField = reviewData.expectedGrade || reviewData.grade;
        anchorFallbackUsed = drawAtField(expectedGradeField, gradeText + '  ', -8) || anchorFallbackUsed;
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

    const outBytes = await pdfDoc.save();

    res.json({
      annotatedPdfBase64: Buffer.from(outBytes).toString('base64'),
      annotatedCount,
      skipped,
      positionWarnings,
      pdfPageCount: pages.length
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
