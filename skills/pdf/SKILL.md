---
name: pdf
description: Read, create, edit, split, merge, extract from, OCR, secure, or fill PDF files. Use only when a PDF is an input or deliverable; use docx, xlsx, or pptx for those native formats.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing

Choose the smallest reliable tool for the requested operation.

| Task | Default approach |
|---|---|
| Read text or tables | `pdftotext` or `pdfplumber` |
| Merge, split, rotate, watermark, encrypt | `pypdf` or `qpdf` |
| Fill forms | Read [forms.md](forms.md) first |
| OCR scanned pages | `pytesseract` plus page-image conversion |
| Create a PDF | `reportlab` for programmatic documents |

## Workflow

1. Inspect page count, encryption, text extractability, and form fields before editing.
2. Preserve the original unless the user explicitly requests in-place changes.
3. For forms, follow [forms.md](forms.md). For advanced operations or troubleshooting, read [reference.md](reference.md) only as needed.
4. Validate the output by reopening it and, for visual changes, render or inspect affected pages.
5. Report the output path, pages affected, and any unavailable dependency or OCR uncertainty.

Use ReportLab markup (`<sub>` and `<super>`) rather than Unicode subscript/superscript glyphs in its built-in fonts.
