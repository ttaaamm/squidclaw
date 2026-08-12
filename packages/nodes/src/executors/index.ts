/**
 * Native node executors — the plug-in library.
 *
 * Each import below runs that module's registerExecutor() calls at load. To add
 * a node type: drop a file in this folder, call registerExecutor there, and add
 * one import line here. n8n-step.ts imports this once; nothing else changes.
 */
import "./ai.js"; // OpenAI / Anthropic / Gemini chat models
import "./image.js"; // OpenAI node — image generation + inline chat
import "./wordpress.js"; // WordPress — draft/publish posts with author + featured image

export { getExecutor, registeredTypes, registerExecutor } from "./registry.js";
export { credentialStore } from "./credentials.js";
