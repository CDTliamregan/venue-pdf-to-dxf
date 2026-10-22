# Venue PDF → Vectorworks DXF

Pull the linework out of a venue PDF and get a clean DXF for Vectorworks. Runs entirely in your browser: the PDF
never leaves your computer.

1. **Upload** a vector PDF exported from CAD or Vectorworks (page 1). Scans and photos won't work because there's no vector data.
2. **Pick** the lines you want: click a line on the plan to grab its whole PDF layer (or its line style if the PDF has
   no layers), or tick layers / line styles in the side panel. Drag to move around, scroll to zoom.
3. Optional: **Crop** (C) a box around the venue, **Erase** (E) boxes over anything you don't want. Cmd/Ctrl+Z undoes an erase.
4. **Export DXF**, then **Download DXF**. One layer, `VENUE_LINES`, in PDF points. The preview is drawn from the DXF itself.
5. In Vectorworks: File › Import › Import DXF/DWG, then Modify › Scale Objects › Symmetric by Distance across a room
   dimension you know. **Verify the scale** against a second measurement.

Created by LR for Creative Day Technologies. Uses [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0, see
`vendor/pdfjs/LICENSE`).
