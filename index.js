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
const MIN_COLUMN_OUTLIER = 0.05;

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

  for (const [, lines] of byExercise) {
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
        if (Math.abs(g.review.boundingBoxes[0][0] - median) > threshold) {
          repaired.set(key, median);
        }
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
    const answers = reviewData.answers || [];

    // Built once per request: which rows have a column position corrupted by
    // the duplicate-text collision, and what their X should actually be.
    const columnRepairs = new Map([
      ...buildColumnRepairMap(answers, 'antwort'),
      ...buildColumnRepairMap(answers, 'fall')
    ]);
    const judgmentColumns = buildJudgmentColumnMap(answers);

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
      const isMediumConfidence = confidence === 'medium';

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
          Math.abs(gradedBox[0] - frageBox[0]) < 0.005 &&
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
        const [x1, y1] = anchorField.review.boundingBoxes[0];
        const { x, y } = toRawCoords(x1, y1, width, height, rotationAngle);

        const subtotalText = `${fmtPoints(sub.awarded)}P / ${fmtPoints(sub.possible)}P`;
        let subX = x;
        let subY = y;
        if (rotationAngle === 270) subX += 40;
        else if (rotationAngle === 90) subX -= 40;
        else if (rotationAngle === 180) subY -= 20;
        else subY += 20;

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
