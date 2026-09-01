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
    const { pdfBase64, reviewData, verdicts } = req.body;

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

    // Real structure: exercises[] -> studentAnswers[] -> {frage, antwort, fall}.
    // Each verdict identifies a row by BOTH exerciseIndex and studentAnswerIndex.
    // Mark position is taken from the 'fall' field (the actual graded answer),
    // falling back to 'antwort' if 'fall' has no coordinate data.
    const exercises = reviewData.exercises || [];

    for (const verdict of verdicts) {
      const exercise = exercises[verdict.exerciseIndex];
      const row = exercise && exercise.studentAnswers && exercise.studentAnswers[verdict.studentAnswerIndex];

      const field = row && (
        (row.fall && row.fall.review && row.fall.review.boundingBoxes && row.fall.review.boundingBoxes.length > 0 && row.fall) ||
        (row.antwort && row.antwort.review && row.antwort.review.boundingBoxes && row.antwort.review.boundingBoxes.length > 0 && row.antwort)
      );

      if (!field || !field.review || !field.review.boundingBoxes || field.review.boundingBoxes.length === 0) {
        skipped.push(`exercise ${verdict.exerciseIndex}, row ${verdict.studentAnswerIndex}`);
        continue;
      }

      const pageIndex = field.review.page - 1;
      const page = pages[pageIndex];
      if (!page) {
        skipped.push(`exercise ${verdict.exerciseIndex}, row ${verdict.studentAnswerIndex} (page ${field.review.page} not found - PDF only has ${pages.length} page(s))`);
        continue;
      }

      const { width, height } = page.getSize();
      const rotationAngle = page.getRotation().angle;
      const [x1, y1] = field.review.boundingBoxes[0]; // normalized 0-1, top-left origin

      const { x: xPos, y: yTop } = toRawCoords(x1, y1, width, height, rotationAngle);

      const color = verdict.isCorrect ? rgb(0, 0.6, 0) : rgb(0.8, 0, 0);
      const symbol = verdict.isCorrect ? 'OK' : 'X';

      // Text must be drawn rotated by the SAME angle as the page rotation,
      // so it appears upright (not sideways/upside-down) once the page's
      // own rotation is applied for viewing - empirically confirmed.
      page.drawText(symbol, {
        x: xPos,
        y: yTop,
        size: 12,
        color,
        rotate: degrees(rotationAngle)
      });

      if (verdict.comment) {
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

    const outBytes = await pdfDoc.save();

    res.json({
      annotatedPdfBase64: Buffer.from(outBytes).toString('base64'),
      annotatedCount,
      skipped,
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
