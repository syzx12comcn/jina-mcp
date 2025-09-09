/**
 * Utility function to handle common API errors for Jina AI services
 * Returns a standardized error response object for MCP tools
 */
export function handleApiError(response: Response, context: string = "API request") {
	if (response.status === 401) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Authentication failed. Please set your API key in the Jina AI MCP settings. You can get a free API key by visiting https://jina.ai and signing up for an account.",
				},
			],
			isError: true,
		};
	}
	if (response.status === 402) {
		return {
			content: [
				{
					type: "text" as const,
					text: "This key is out of quota. Please top up this key at https://jina.ai",
				},
			],
			isError: true,
		};
	}
	
	if (response.status === 429) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Rate limit exceeded. Please upgrade your API key to get higher rate limits. Visit https://jina.ai to manage your subscription and increase your usage limits.",
				},
			],
			isError: true,
		};
	}
	
	// Default error message for other HTTP errors
	return {
		content: [
			{
				type: "text" as const,
				text: `Error: ${context} failed - ${response.status} ${response.statusText}`,
			},
		],
		isError: true,
	};
}

/**
 * Check if bearer token is available and return appropriate error message if not
 */
export function checkBearerToken(bearerToken: string | undefined) {
	if (!bearerToken) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Please set your API key in the Jina AI MCP settings. You can get a free API key by visiting https://jina.ai and signing up for an account.",
				},
			],
			isError: true,
		};
	}
	return null; // No error, token is available
}
