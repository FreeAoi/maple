import { apiPublicUrl } from "./api-base-url"

const configuredMcpUrl = import.meta.env.VITE_MCP_URL?.trim()

export const mcpUrl =
	configuredMcpUrl && configuredMcpUrl.length > 0 ? configuredMcpUrl.replace(/\/$/, "") : apiPublicUrl
