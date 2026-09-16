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

const app = express();

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
    // Embedded once so the right-margin frage marks can be right-aligned
    // (measuring real text width), guaranteeing they end within the page
    // regardless of comment length, rather than guessing a fraction that
    // happens to fit today's specific comment text.
    const marginFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let annotatedCount = 0;
    const skipped = [];
    const positionWarnings = [];
    const lastMarkPosByPage = {};

    // Verdicts now target a SPECIFIC field (frage/antwort/fall) per row,
    // one verdict per gradable part rather than one per whole row.
    const answers = reviewData.answers || [];

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
      const exerciseTypeValue = row && (row.exerciseType && row.exerciseType.value !== undefined ? row.exerciseType.value : row.exerciseType);
      const useHybridAnchor =
        (exerciseTypeValue === 'true_false_correction' && verdict.field === 'antwort' && row.subPart !== 'b') ||
        (exerciseTypeValue === 'case_identification' && verdict.field === 'fall') ||
        (exerciseTypeValue === 'preposition_only' && verdict.field === 'antwort');

      const gradedField = row && row[verdict.field];
      const frageField = row && row.frage;
      const hasBoxes = (f) => f && f.review && f.review.boundingBoxes && f.review.boundingBoxes.length > 0;

      // The field we check confidence against and treat as "the" field for
      // page/rotation lookup - always the graded field itself, since that's
      // what's semantically being evaluated.
      const field = gradedField;

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
      const [gx1, gy1] = field.review.boundingBoxes[0]; // graded field's own normalized coords
      let x1 = gx1;
      let y1 = gy1;

      if (useHybridAnchor && hasBoxes(frageField) && frageField.review.page === field.review.page) {
        const [, fy1] = frageField.review.boundingBoxes[0];
        y1 = fy1; // row position from frage (always unique); column (x1) stays from the graded field
      }

      // FIX (further revised): a FIXED page-fraction margin is fragile
      // across different scans of the SAME test - scan skew, a different
      // crop, or slightly different paper alignment can all shift where
      // the table actually sits as a percentage of that particular scan's
      // page width, especially with the ~3% clearance this table's layout
      // leaves to work with. Instead, derive the margin position from THIS
      // SAME SCAN's own 'fall' field right edge - boundingBoxes are
      // [x1,y1,x2,y2], and x2 (the right edge) was previously unused here.
      // This makes the margin move WITH wherever the table actually sits
      // on any given scan, rather than assuming every scan lines up
      // identically.
      if (verdict.field === 'frage') {
        const fallField = row && row.fall;
        const MARGIN_GAP_POINTS = 15; // desired absolute gap, in PDF points, past the Fall column's own right edge
        if (hasBoxes(fallField) && fallField.review.page === field.review.page && fallField.review.boundingBoxes[0].length >= 4) {
          const fallX2 = fallField.review.boundingBoxes[0][2]; // right edge of THIS row's Fall column, normalized
          x1 = Math.min(fallX2 + (MARGIN_GAP_POINTS / width), 0.99);
        } else {
          // Fallback if this row has no usable 'fall' box to anchor from
          // (shouldn't happen for qa_composition, but keeps this safe for
          // any other future exercise type that might reuse this path) -
          // a fixed-fraction guess as a last resort only.
          x1 = 0.95;
        }
      }

      let { x: xPos, y: yTop } = toRawCoords(x1, y1, width, height, rotationAngle);

      // The frage field's own Y sits at the very TOP of its row's text
      // (where the handwritten question starts), which visually crowds
      // right up against the row ABOVE's own Fall-column mark. Nudge it
      // down slightly, moving it away from the boundary and toward the
      // vertical center of its own row, rather than hugging the top edge.
      if (verdict.field === 'frage') {
        if (rotationAngle === 270) xPos -= 10;
        else if (rotationAngle === 90) xPos += 10;
        else if (rotationAngle === 180) yTop += 10;
        else yTop -= 10;
      }

      // LAST-RESORT safety net: if this mark would land essentially on top
      // of the previously-drawn mark on this same page (within a few px in
      // both directions), nudge it aside so it's at least visible. Unlike
      // the frage-anchor fix above, this does NOT put the mark on its
      // genuinely correct position - it only prevents one mark from
      // silently hiding behind another when even the anchor field
      // coincides. This should rarely trigger now that frage is used for
      // the exercise types where duplicate values were the actual cause;
      // treat any occurrence of this as a signal worth investigating rather
      // than a real fix.
      const COLLISION_THRESHOLD = 4; // px
      const lastPos = lastMarkPosByPage[pageIndex];
      if (lastPos && Math.abs(xPos - lastPos.x) < COLLISION_THRESHOLD && Math.abs(yTop - lastPos.y) < COLLISION_THRESHOLD) {
        if (rotationAngle === 270) xPos -= 14;
        else if (rotationAngle === 90) xPos += 14;
        else if (rotationAngle === 180) yTop += 14;
        else yTop -= 14;
        positionWarnings.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} - nudged: landed on top of the previous mark even after frage-anchoring; position is a visibility fix only, not confirmed correct`);
      }
      lastMarkPosByPage[pageIndex] = { x: xPos, y: yTop };

      const color = verdict.isCorrect ? rgb(0, 0.6, 0) : rgb(0.8, 0, 0);
      const pointsLabel = (verdict.pointsPossible !== undefined && verdict.pointsPossible !== null)
        ? `${verdict.pointsAwarded ?? 0}/${verdict.pointsPossible}P`
        : (verdict.isCorrect ? 'OK' : 'X');

      // The right-margin frage marks need to be RIGHT-aligned (ending at
      // RIGHT_MARGIN_X_FRACTION), not left-aligned starting there - a first
      // attempt at this fraction as a left-aligned start position got the
      // text clipped clean off by the page's own right edge, since text
      // extends rightward from its start point. Right-aligning means the
      // text always ends within the page regardless of how long a
      // particular comment happens to be, rather than guessing a smaller
      // start fraction that only happens to fit today's specific text.
      const isFrageMargin = verdict.field === 'frage';
      function shiftAlongTextDirection(x, y, distance, angle) {
        const rad = (angle * Math.PI) / 180;
        return { x: x + distance * Math.cos(rad), y: y + distance * Math.sin(rad) };
      }
      if (isFrageMargin) {
        const labelWidth = marginFont.widthOfTextAtSize(pointsLabel, 12);
        const shifted = shiftAlongTextDirection(xPos, yTop, -labelWidth, rotationAngle);
        xPos = shifted.x;
        yTop = shifted.y;
      }

      // Medium confidence: the box was placed on the cited text, but that
      // text didn't read back the same as the extracted value (per Nitai -
      // often an OCR/handwriting mismatch, or the model itself was unsure).
      // The location is usually right, just not confirmed - draw a dashed
      // orange outline around the mark so a teacher knows to double-check
      // this specific one, without hiding it entirely like "low" does.
      if (isMediumConfidence) {
        const labelWidthEstimate = pointsLabel.length * 12 * 0.6 + 6;
        page.drawRectangle({
          x: xPos - 3,
          y: yTop - 3,
          width: labelWidthEstimate,
          height: 12 + 4,
          borderColor: rgb(0.95, 0.6, 0),
          borderWidth: 1.2,
          borderDashArray: [3, 2],
          rotate: degrees(rotationAngle)
        });
      }

      // Text must be drawn rotated by the SAME angle as the page rotation,
      // so it appears upright (not sideways/upside-down) once the page's
      // own rotation is applied for viewing - empirically confirmed.
      page.drawText(pointsLabel, {
        x: xPos,
        y: yTop,
        size: 12,
        color,
        rotate: degrees(rotationAngle)
      });

      // Margin marks skip the comment entirely - measured pixel evidence
      // showed this table spans almost the full page width, leaving only
      // ~20pt of genuine clearance past its right border. That's enough
      // for the short point-value line, but nowhere near enough for a full
      // comment, which would have to reach back into the Fall column's own
      // marks regardless of right-alignment. The antwort/fall marks on the
      // same row keep their own full comments, so the row isn't left
      // without feedback - only the frage-specific explanation is dropped.
      if (verdict.comment && !isFrageMargin) {
        // Offset the comment slightly "below" the mark, in the rotated
        // frame's own sense of down - handled by nudging along whichever
        // raw axis corresponds to visual-down for this rotation.
        let commentX = xPos;
        let commentY = yTop;
        if (rotationAngle === 270) commentX -= 12;
        else if (rotationAngle === 90) commentX += 12;
        else if (rotationAngle === 180) commentY += 12;
        else commentY -= 12;

        page.drawText(verdict.comment, {
          x: commentX,
          y: commentY,
          size: 7,
          color,
          rotate: degrees(rotationAngle)
        });
      }

      annotatedCount++;
    }

    // Draw a per-sub-part subtotal (e.g. "3.5P / 5.0P") near the first row
    // of that sub-part, approximating "next to the exercise/sub-part title"
    // since we don't have a dedicated title-coordinate field - the first
    // matching answer row is the closest reliable anchor we have.
    function getExerciseNumberValue(row) {
      const raw = row.exerciseNumber;
      return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    }
    function getSubPartValue(row) {
      const raw = row.subPart;
      return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    }

    if (Array.isArray(subtotals)) {
      for (const sub of subtotals) {
        // sub.key looks like "1a", "1b", or just "2" (no sub-part letter).
        const match = String(sub.key).match(/^(\d+)([a-zA-Z]?)$/);
        if (!match) continue;
        const [, exNumStr, subPartLetter] = match;
        const exNum = parseInt(exNumStr, 10);

        const firstRowIndex = answers.findIndex(a => {
          const rowExNum = getExerciseNumberValue(a);
          const rowSubPart = getSubPartValue(a);
          if (String(rowExNum) !== String(exNum)) return false;
          if (subPartLetter === 'a') return rowSubPart === 'a' || !rowSubPart; // null/undefined subPart defaults to 'a' by convention (matches node 21 and the true_false_correction template)
          if (subPartLetter) return rowSubPart === subPartLetter;
          return !rowSubPart; // no letter in key means match rows with no subPart
        });
        if (firstRowIndex === -1) continue;

        const row = answers[firstRowIndex];
        const anchorField = row.frage || row.antwort || row.fall;
        if (!anchorField || !anchorField.review || !anchorField.review.boundingBoxes || anchorField.review.boundingBoxes.length === 0) continue;

        const page = pages[anchorField.review.page - 1];
        if (!page) continue;

        const { width, height } = page.getSize();
        const rotationAngle = page.getRotation().angle;
        const [x1, y1] = anchorField.review.boundingBoxes[0];
        const { x, y } = toRawCoords(x1, y1, width, height, rotationAngle);

        const possibleText = sub.possible !== null && sub.possible !== undefined ? sub.possible : '?';
        const subtotalText = `${sub.awarded}P / ${possibleText}P`;
        let subX = x;
        let subY = y;
        if (rotationAngle === 270) subX += 40;
        else if (rotationAngle === 90) subX -= 40;
        else if (rotationAngle === 180) subY -= 20;
        else subY += 20;

        page.drawText(subtotalText, {
          x: subX, y: subY, size: 11, color: rgb(0, 0, 0.6), rotate: degrees(rotationAngle)
        });
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
      const scoreText = `${totalPointsAwarded}P / ${totalPointsPossible}P`;
      const gradeText = swissGrade !== null ? `${swissGrade}` : '';

      const punkteField = reviewData.totalScore || reviewData.totalPoints || reviewData.Punkte || reviewData.punkte;
      const noteField = reviewData.finalGrade || reviewData.grade || reviewData.Note || reviewData.note;

      function drawAtField(field, text, yNudge) {
        if (!field || !field.review || !field.review.boundingBoxes || field.review.boundingBoxes.length === 0) return false;
        const page = pages[field.review.page - 1];
        if (!page) return false;
        const { width, height } = page.getSize();
        const rotationAngle = page.getRotation().angle;
        const [x1, y1] = field.review.boundingBoxes[0];
        const { x, y } = toRawCoords(x1, y1, width, height, rotationAngle);
        page.drawText(text, { x, y: y + (yNudge || 0), size: 12, color: rgb(0, 0, 0.7), rotate: degrees(rotationAngle) });
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
        lastPage.drawText(`Total: ${scoreText}${gradeText ? ' - Grade: ' + gradeText : ''}`, {
          x, y, size: 14, color: rgb(0, 0, 0), rotate: degrees(lastPageRotation)
        });
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
