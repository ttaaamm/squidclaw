import { registerNode } from "@squidclaw/kernel";
import { echoNode } from "./echo.js";
import { httpRequestNode } from "./http-request.js";
import { shellExecNode, sshExecNode } from "./shell.js";
import { webSearchNode, webReadNode } from "./web.js";
import { pdfCreateNode, pptxCreateNode } from "./documents.js";
import { squidflowImportNode, unsupportedNode } from "./n8n-import.js";
import { n8nStepNode } from "./n8n-step.js";
import { telegramSendNode, telegramPollNode } from "./telegram.js";
import { visionLookNode, voiceSayNode, transcribeNode } from "./senses.js";
import { emailSendNode, emailReadNode } from "./email.js";
import { docReadNode } from "./doc-read.js";
import { gotenbergRenderNode, canvasSnapNode, browserSnapNode } from "./gotenberg.js";

export * from "./echo.js";
export * from "./http-request.js";
export * from "./shell.js";
export * from "./web.js";
export * from "./documents.js";
export * from "./n8n-import.js";
export * from "./n8n-step.js";
export * from "./mcp.js";
export * from "./telegram.js";
export * from "./gotenberg.js";
export * from "./senses.js";
export * from "./doc-read.js";
export * from "./email.js";

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
    squidflowImportNode,
    n8nStepNode,
    unsupportedNode,
    telegramSendNode(),
    gotenbergRenderNode(),
    canvasSnapNode(),
    visionLookNode(),
    voiceSayNode(),
    transcribeNode(),
    docReadNode(),
    browserSnapNode(),
    telegramPollNode(),
    emailSendNode(),
    emailReadNode(),
  ]) {
    registerNode(node);
  }
}
