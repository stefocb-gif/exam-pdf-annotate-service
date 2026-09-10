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
const { PDFDocument, rgb, degrees } = require('pdf-lib');

// TOGGLE: set to true to re-enable the small explanatory comment text under
// each mark (e.g. "Korrekte Option gewählt"). Currently off by request -
// only the score itself (e.g. "1/1P") is shown, not the reasoning behind it.
const SHOW_COMMENTS = false;

// TOGGLE: set to true to re-enable per-exercise/sub-part subtotal display
// (e.g. "3.5P / 5.0P" near an exercise heading). Currently off by request -
// positioning proved unreliable on some documents regardless of rotation,
// so this is now a simple explicit on/off switch rather than an inferred
// per-document decision.
const SHOW_SUBTOTALS = false;

// Font size used for every score mark drawn on the page - per-question marks
// and the header total/grade both use this, so they always match visually.
const MARK_FONT_SIZE = 14;

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

    let annotatedCount = 0;
    const skipped = [];

    // Verdicts now target a SPECIFIC field (frage/antwort/fall) per row,
    // one verdict per gradable part rather than one per whole row.
    const answers = reviewData.answers || [];

    // Where in the page (as a fraction of width, 0=left edge, 1=right edge)
    // the score column should sit. Tune this single number if marks need to
    // move left/right - everything else derives from it automatically for
    // any page rotation, since it's expressed in the same normalized 0-1
    // space DocuPipe already uses for coordinates.
    const RIGHT_MARGIN_X_FRACTION = 0.94;

    // Some exercise types (qa_composition, fill_blank_with_case) grade TWO
    // fields on the same row (e.g. both 'antwort' and 'fall'), producing two
    // verdicts that share one answerIndex. Since both now anchor to that
    // row's single 'frage' point, track how many marks have already been
    // drawn per row so additional ones stack downward instead of landing
    // exactly on top of the first.
    const rowMarkCounts = {};
    const STACK_STEP = 18; // vertical spacing (px) between stacked marks on the same row

    // Separate from the same-row stacking above: consecutive DIFFERENT rows
    // can also sit close enough together in the original document (e.g.
    // sub-items i./ii./iii. of a fill-in-the-blank list) that their
    // independently-anchored marks visually collide. This tracks the last
    // mark's position per page and nudges the next one further apart if it
    // would otherwise land within MIN_MARK_GAP of the previous one.
    const lastMarkAxisByPage = {};
    const MIN_MARK_GAP = 20; // minimum px between consecutive marks, regardless of which row they belong to

    // Returns a single number that increases as you move visually "down"
    // the page, regardless of rotation - reuses the same per-rotation axis
    // convention already established elsewhere in this file (see the
    // stacking and comment-offset logic below).
    function visualDownAxis(x, y, rotationAngle) {
      if (rotationAngle === 270) return -x;
      if (rotationAngle === 90) return x;
      if (rotationAngle === 180) return y;
      return -y;
    }

    for (const verdict of verdicts) {
      const row = answers[verdict.answerIndex];

      // ANCHOR CHANGE: every mark is now anchored to the row's own question
      // TITLE ('frage'), not to the specific graded field ('antwort'/'fall').
      // Reasons this is more reliable AND matches how a human teacher marks
      // a paper (one score per question, written in the margin next to that
      // question, not stamped on top of the handwriting):
      //   1. 'frage' text is unique per row on this exam, so it doesn't hit
      //      the duplicate-text coordinate collision Nitai confirmed for
      //      repeated answer values (e.g. several "Richtig" rows).
      //   2. On multiple_choice rows specifically, the 'antwort' coordinate
      //      has been landing ON the question text itself (suspected
      //      DocuPipe imprecision) - anchoring to 'frage' directly instead
      //      of fighting that miscoordinate sidesteps the problem entirely.
      // Falls back to the graded field itself if a row has no 'frage'
      // (shouldn't happen on this exam's schema, but keeps old rows safe).
      const anchorField = (row && row.frage) || (row && row[verdict.field]);

      if (!anchorField || !anchorField.review || !anchorField.review.boundingBoxes || anchorField.review.boundingBoxes.length === 0) {
        skipped.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field}`);
        continue;
      }

      const pageIndex = anchorField.review.page - 1;
      const page = pages[pageIndex];
      if (!page) {
        skipped.push(`answerIndex ${verdict.answerIndex}, field ${verdict.field} (page ${anchorField.review.page} not found - PDF only has ${pages.length} page(s))`);
        continue;
      }

      const { width, height } = page.getSize();
      const rotationAngle = page.getRotation().angle;
      const [, y1] = anchorField.review.boundingBoxes[0]; // normalized 0-1, top-left origin - only the row's vertical position is used

      // Use the row's own title height (y1) but force the horizontal
      // position to the right-margin column (RIGHT_MARGIN_X_FRACTION)
      // instead of the title's own x1. Plugging a fixed normalized x into
      // the SAME rotation-aware transform used everywhere else in this file
      // means this works correctly regardless of page rotation, without
      // needing a separate per-rotation "which raw axis is right" case.
      let { x: xPos, y: yTop } = toRawCoords(RIGHT_MARGIN_X_FRACTION, y1, width, height, rotationAngle);

      // Small nudge so the mark's text baseline lines up visually with the
      // title text on that row, rather than sitting exactly at its top edge.
      if (rotationAngle === 270) xPos += 4;
      else if (rotationAngle === 90) xPos -= 4;
      else if (rotationAngle === 180) yTop -= 4;
      else yTop += 4;

      // Apply the stacking offset (if this is the 2nd+ mark on this row),
      // moving in whichever raw direction is visually "down" for this
      // rotation - same directional convention used for the comment offset
      // below.
      const stackIndex = rowMarkCounts[verdict.answerIndex] || 0;
      rowMarkCounts[verdict.answerIndex] = stackIndex + 1;
      const stackOffset = stackIndex * STACK_STEP;
      if (stackOffset > 0) {
        if (rotationAngle === 270) xPos -= stackOffset;
        else if (rotationAngle === 90) xPos += stackOffset;
        else if (rotationAngle === 180) yTop += stackOffset;
        else yTop -= stackOffset;
      }

      // Cross-row collision check: if this mark would land within
      // MIN_MARK_GAP of the previous mark drawn on this page (e.g. tightly
      // stacked sub-items like i./ii./iii.), push it further down until
      // there's enough visual separation.
      let axis = visualDownAxis(xPos, yTop, rotationAngle);
      const lastAxis = lastMarkAxisByPage[pageIndex];
      if (lastAxis !== undefined && axis - lastAxis < MIN_MARK_GAP) {
        const deficit = MIN_MARK_GAP - (axis - lastAxis);
        if (rotationAngle === 270) xPos -= deficit;
        else if (rotationAngle === 90) xPos += deficit;
        else if (rotationAngle === 180) yTop += deficit;
        else yTop -= deficit;
        axis = visualDownAxis(xPos, yTop, rotationAngle);
      }
      lastMarkAxisByPage[pageIndex] = axis;

      const color = verdict.isCorrect ? rgb(0, 0.6, 0) : rgb(0.8, 0, 0);
      const pointsLabel = (verdict.pointsPossible !== undefined && verdict.pointsPossible !== null)
        ? `${verdict.pointsAwarded ?? 0}/${verdict.pointsPossible}P`
        : (verdict.isCorrect ? 'OK' : 'X');

      // Draw a white background rectangle behind the score text first, so
      // it stays readable against busy handwriting/highlighting underneath -
      // sized generously based on character count (avoids needing precise
      // font-metric measurement for a simple readability improvement).
      const labelFontSize = MARK_FONT_SIZE;
      const estimatedWidth = pointsLabel.length * labelFontSize * 0.52;
      const estimatedHeight = labelFontSize * 1.15;
      page.drawRectangle({
        x: xPos - 2,
        y: yTop - 3,
        width: estimatedWidth,
        height: estimatedHeight,
        color: rgb(1, 1, 1),
        rotate: degrees(rotationAngle)
      });

      // Text must be drawn rotated by the SAME angle as the page rotation,
      // so it appears upright (not sideways/upside-down) once the page's
      // own rotation is applied for viewing - empirically confirmed.
      page.drawText(pointsLabel, {
        x: xPos,
        y: yTop,
        size: labelFontSize,
        color,
        rotate: degrees(rotationAngle)
      });

      if (SHOW_COMMENTS && verdict.comment) {
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
    //
    // IMPORTANT: this feature's positioning has only been validated for
    // rotation=270 (the original exam's scanned documents). On other
    // layouts (e.g. digitally-created PDFs), subtotals have landed in
    // unreliable/wrong positions - rather than keep guessing at fixes,
    // this is disabled entirely for untested rotations. Individual
    // per-answer marks and the final total/grade are unaffected.
    function getExerciseNumberValue(row) {
      const raw = row.exerciseNumber;
      return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    }
    function getSubPartValue(row) {
      const raw = row.subPart;
      return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    }

    const subtotalsValidatedForThisDocument = SHOW_SUBTOTALS;

    if (Array.isArray(subtotals) && subtotalsValidatedForThisDocument) {
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

    let headerFieldsDebug = null;

    // Place the total score and computed grade using FIXED, hardcoded
    // page-relative coordinates for this exam's header row, rather than any
    // DocuPipe field coordinate.
    //
    // WHY: real-world debug data confirmed that every candidate field
    // (totalScore, Punkte, finalGrade, Note, expectedGrade, etc.) has NO
    // coordinates at all on this document, and the one field that DOES have
    // a coordinate ('maxPoints') points to the instructions paragraph, not
    // to where "/15" is actually printed in the header table - i.e. it's a
    // genuinely wrong coordinate, not just an offset that needs tuning. No
    // amount of nudging a wrong anchor produces a right position.
    //
    // Since this exam type is always the same static "TEST A" template
    // (same header layout on every student's copy), fixed normalized
    // coordinates are more reliable here than any DocuPipe field - this is
    // effectively treating the header as a known print-shop form field
    // rather than something to be located dynamically.
    //
    // FIRST-PASS TUNING: these four numbers are a starting estimate from
    // visually inspecting the header layout, not yet confirmed pixel-exact.
    // If placement is off after this run, these are the only numbers that
    // need adjusting - everything else (rotation handling, etc.) stays put.
    const HEADER_PAGE_INDEX = 0;   // header is always on page 1 for this template
    const PUNKTE_X_FRACTION = 0.665; // gap between "Punkte:" and "/15"
    const PUNKTE_Y_FRACTION = 0.055; // vertical position of the header row
    const NOTE_X_FRACTION = 0.895;   // just right of the "Note:" label
    const NOTE_Y_FRACTION = 0.055;   // same header row height

    if (totalPointsAwarded !== undefined && totalPointsPossible !== undefined) {
      const swissGrade = computeSwissGrade(totalPointsAwarded, totalPointsPossible);
      const scoreText = `${totalPointsAwarded}P/${totalPointsPossible}P`;
      const gradeText = swissGrade !== null ? `Note: ${swissGrade}` : '';

      const headerPage = pages[HEADER_PAGE_INDEX];
      let punkteDrawn = false;
      let noteDrawn = false;

      if (headerPage) {
        const { width, height } = headerPage.getSize();
        const rotationAngle = headerPage.getRotation().angle;

        const punktePos = toRawCoords(PUNKTE_X_FRACTION, PUNKTE_Y_FRACTION, width, height, rotationAngle);
        headerPage.drawText(scoreText, {
          x: punktePos.x, y: punktePos.y, size: MARK_FONT_SIZE, color: rgb(0, 0, 0.7), rotate: degrees(rotationAngle)
        });
        punkteDrawn = true;

        if (gradeText) {
          const notePos = toRawCoords(NOTE_X_FRACTION, NOTE_Y_FRACTION, width, height, rotationAngle);
          headerPage.drawText(gradeText, {
            x: notePos.x, y: notePos.y, size: MARK_FONT_SIZE, color: rgb(0, 0, 0.7), rotate: degrees(rotationAngle)
          });
          noteDrawn = true;
        }
      }

      // DEBUG: this doesn't affect what's drawn on the PDF - it just reports
      // the raw coordinates (if any) for every candidate header field, so we
      // can see exactly what DocuPipe actually returned. Kept for reference
      // in case a future exam template needs field-based positioning again.
      function describeField(field) {
        if (!field) return null;
        if (!field.review || !field.review.boundingBoxes || field.review.boundingBoxes.length === 0) {
          return { hasCoordinates: false, value: field.value !== undefined ? field.value : field };
        }
        return {
          hasCoordinates: true,
          value: field.value !== undefined ? field.value : field,
          page: field.review.page,
          boundingBox: field.review.boundingBoxes[0]
        };
      }
      headerFieldsDebug = {
        maxScore: describeField(reviewData.maxScore),
        maxPoints: describeField(reviewData.maxPoints),
        totalScore: describeField(reviewData.totalScore),
        totalPoints: describeField(reviewData.totalPoints),
        Punkte: describeField(reviewData.Punkte),
        punkte: describeField(reviewData.punkte),
        finalGrade: describeField(reviewData.finalGrade),
        grade: describeField(reviewData.grade),
        Note: describeField(reviewData.Note),
        note: describeField(reviewData.note),
        expectedGrade: describeField(reviewData.expectedGrade)
      };

      // Last resort: corner of the last page, so the total is never silently
      // lost even if no anchor fields exist at all.
      if (!punkteDrawn && !noteDrawn) {
        const lastPage = pages[pages.length - 1];
        const lastPageRotation = lastPage.getRotation().angle;
        const { x, y } = toRawCoords(0.05, 0.95, lastPage.getWidth(), lastPage.getHeight(), lastPageRotation);
        lastPage.drawText(`Total: ${totalPointsAwarded}P / ${totalPointsPossible}P${gradeText ? ' - Grade: ' + gradeText : ''}`, {
          x, y, size: 14, color: rgb(0, 0, 0), rotate: degrees(lastPageRotation)
        });
      }
    }

    const outBytes = await pdfDoc.save();

    res.json({
      annotatedPdfBase64: Buffer.from(outBytes).toString('base64'),
      annotatedCount,
      skipped,
      pdfPageCount: pages.length,
      headerFieldsDebug
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
