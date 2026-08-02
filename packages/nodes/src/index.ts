import { registerNode } from "@squidclaw/kernel";
import { echoNode } from "./echo.js";
import { httpRequestNode } from "./http-request.js";

export { echoNode, httpRequestNode };

export function registerBuiltinNodes(): void {
  registerNode(echoNode);
  registerNode(httpRequestNode);
}
