import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pptxgen from "pptxgenjs";

const PptxGenJS = pptxgen as unknown as new () => InstanceType<typeof import("pptxgenjs").default>;
import type { NodeDef } from "@squidclaw/kernel";

/** Minimal, dependency-free PDF writer — enough for reports and letters. */
export function buildPdf(title: string, body: string): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const wrap = (text: string, width: number): string[] =>
    text.split("\n").flatMap((para) => {
      if (!para.trim()) return [""];
      const out: string[] = [];
      let line = "";
      for (const word of para.split(/\s+/)) {
        if ((line + " " + word).trim().length > width) {
          out.push(line.trim());
          line = word;
        } else line += ` ${word}`;
      }
      if (line.trim()) out.push(line.trim());
      return out;
    });

  const lines = wrap(body, 88);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 46) pages.push(lines.slice(i, i + 46));
  if (!pages.length) pages.push([]);

  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((pageLines, idx) => {
    const id = pageIds[idx];
    let stream = "BT\n";
    if (idx === 0) {
      stream += `/F1 18 Tf 60 780 Td (${esc(title)}) Tj\n/F1 11 Tf 0 -30 Td\n`;
    } else {
      stream += "/F1 11 Tf 60 780 Td\n";
    }
    for (const line of pageLines) stream += `(${esc(line)}) Tj 0 -15 Td\n`;
    stream += "ET";
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf);
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    pdf += offsets[i] ? `${String(offsets[i]).padStart(10, "0")} 00000 n \n` : `0000000000 65535 f \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

export const pdfCreateNode: NodeDef = {
  name: "pdf.create",
  description:
    "Create a PDF document. Params: path (where to save, required), title (required), body (the text content; blank lines separate paragraphs). Returns the saved path.",
  inputSchema: {
    type: "object",
    required: ["path", "title", "body"],
    properties: { path: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
  },
  run: async (params) => {
    const path = resolve(String(params.path));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buildPdf(String(params.title), String(params.body)));
    return [{ json: { path, kind: "pdf" } }];
  },
};

export interface SlideSpec {
  title: string;
  bullets?: string[];
  notes?: string;
}

export const pptxCreateNode: NodeDef = {
  name: "pptx.create",
  description:
    "Create a PowerPoint presentation. Params: path (where to save, required), title (deck title, required), slides (array of {title, bullets[], notes}). Returns the saved path.",
  inputSchema: {
    type: "object",
    required: ["path", "title", "slides"],
    properties: {
      path: { type: "string" },
      title: { type: "string" },
      subtitle: { type: "string" },
      slides: {
        type: "array",
        items: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
        },
      },
    },
  },
  run: async (params) => {
    const path = resolve(String(params.path));
    mkdirSync(dirname(path), { recursive: true });

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";

    const cover = pptx.addSlide();
    cover.addText(String(params.title), { x: 0.6, y: 2.2, w: 8.8, h: 1, fontSize: 40, bold: true });
    if (params.subtitle) {
      cover.addText(String(params.subtitle), { x: 0.6, y: 3.3, w: 8.8, h: 0.6, fontSize: 18, color: "666666" });
    }

    for (const spec of (params.slides as SlideSpec[]) ?? []) {
      const slide = pptx.addSlide();
      slide.addText(spec.title, { x: 0.6, y: 0.4, w: 8.8, h: 0.8, fontSize: 28, bold: true });
      if (spec.bullets?.length) {
        slide.addText(
          spec.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
          { x: 0.8, y: 1.5, w: 8.4, h: 3.6, fontSize: 18 },
        );
      }
      if (spec.notes) slide.addNotes(spec.notes);
    }

    await pptx.writeFile({ fileName: path });
    return [{ json: { path, kind: "pptx", slides: ((params.slides as SlideSpec[]) ?? []).length + 1 } }];
  },
};
