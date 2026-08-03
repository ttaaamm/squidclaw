import { registerNode } from "@squidclaw/kernel";
import { echoNode } from "./echo.js";
import { httpRequestNode } from "./http-request.js";
import { shellExecNode, sshExecNode } from "./shell.js";
import { webSearchNode, webReadNode } from "./web.js";
import { pdfCreateNode, pptxCreateNode } from "./documents.js";
import { n8nImportNode, unsupportedNode } from "./n8n-import.js";
import { telegramSendNode } from "./telegram.js";
import { visionLookNode, voiceSayNode, transcribeNode } from "./senses.js";
import { gotenbergRenderNode, canvasSnapNode } from "./gotenberg.js";

export * from "./echo.js";
export * from "./http-request.js";
export * from "./shell.js";
export * from "./web.js";
export * from "./documents.js";
export * from "./n8n-import.js";
export * from "./mcp.js";
export * from "./telegram.js";
export * from "./gotenberg.js";
export * from "./senses.js";

export function registerBuiltinNodes(): void {
  for (const node of [
    echoNode,
    httpRequestNode,
    shellExecNode,
    sshExecNode,
    webSearchNode(),
    webReadNode,
    pdfCreateNode,
    pptxCreateNode,
    n8nImportNode,
    unsupportedNode,
    telegramSendNode(),
    gotenbergRenderNode(),
    canvasSnapNode(),
    visionLookNode(),
    voiceSayNode(),
    transcribeNode(),
  ]) {
    registerNode(node);
  }
}
