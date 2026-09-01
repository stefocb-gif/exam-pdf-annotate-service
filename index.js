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
const { PDFDocument, rgb } = require('pdf-lib');

const app = express();

// Exam PDFs with images can be large - raise the body size limit.
app.use(express.json({ limit: '25mb' }));

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

    for (const verdict of verdicts) {
      const field = reviewData[verdict.questionId];

      if (!field || !field.review || !field.review.boundingBoxes || field.review.boundingBoxes.length === 0) {
        skipped.push(verdict.questionId);
        continue;
      }

      const pageIndex = field.review.page - 1;
      const page = pages[pageIndex];
      if (!page) {
        skipped.push(verdict.questionId);
        continue;
      }

      const { width, height } = page.getSize();
      const [x1, y1, , y2] = field.review.boundingBoxes[0]; // normalized 0-1

      // Convert normalized coordinates to actual page points.
      // PDF coordinate origin is bottom-left, so we flip the y-axis.
      const xPos = x1 * width;
      const yTop = height - (y1 * height);

      const color = verdict.isCorrect ? rgb(0, 0.6, 0) : rgb(0.8, 0, 0);
      const symbol = verdict.isCorrect ? 'OK' : 'X';

      page.drawText(symbol, {
        x: Math.max(xPos - 22, 2),
        y: yTop,
        size: 12,
        color
      });

      if (verdict.comment) {
        page.drawText(verdict.comment, {
          x: xPos,
          y: yTop - 12,
          size: 7,
          color
        });
      }

      annotatedCount++;
    }

    const outBytes = await pdfDoc.save();

    res.json({
      annotatedPdfBase64: Buffer.from(outBytes).toString('base64'),
      annotatedCount,
      skipped
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
