import { z } from "zod";
import { stringify as yamlStringify } from "yaml";

import { handleApiError, checkBearerToken } from "../utils/api-error-handler.js";
import { lazyGreedySelection, lazyGreedySelectionWithSaturation } from "../utils/submodular-optimization.js";
import { downloadImages } from "../utils/image-downloader.js";
import {
	executeParallelSearches,
	executeWebSearch,
	executeArxivSearch,
	executeImageSearch,
	type SearchWebArgs,
	type SearchArxivArgs,
	type SearchImageArgs,
	formatSingleSearchResultToContentItems,
	formatParallelSearchResultsToContentItems
} from "../utils/search.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerJinaTools(server: McpServer, getProps: () => any) {
	// Helper function to create error responses
	const createErrorResponse = (message: string) => ({
		content: [{ type: "text" as const, text: message }],
		isError: true,
	});

	// Show API key tool - returns the bearer token from request headers
	server.tool(
		"show_api_key",
		"Return the bearer token from the Authorization header of the MCP settings, which is used to debug.",
		{},
		async () => {
			const props = getProps();
			const token = props.bearerToken as string;
			if (!token) {
				return createErrorResponse("No bearer token found in request");
			}
			return {
				content: [{ type: "text" as const, text: token }],
			};
		},
	);

	// Primer tool - provides current world knowledge for LLMs
	server.tool(
		"primer",
		"Get up-to-date contextual information of the current session to provide localized, time-aware responses. Use this when you need to know the current time, user's location, or network environment to give more relevant and personalized information.",
		{},
		async () => {
			try {
				const props = getProps();
				const context = props.context;

				if (!context) {
					throw new Error("No context information available");
				}

				return {
					content: [{ type: "text" as const, text: yamlStringify(context) }],
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Guess datetime from URL tool - analyzes web pages for datetime information
	server.tool(
		"guess_datetime_url",
		"Guess the last updated or published datetime of a web page. This tool examines HTTP headers, HTML metadata, Schema.org data, visible dates, JavaScript timestamps, HTML comments, Git information, RSS/Atom feeds, sitemaps, and international date formats to provide the most accurate update time with confidence scores. Returns the best guess timestamp and confidence level.",
		{
			url: z.string().url().describe("The complete HTTP/HTTPS URL of the webpage to guess datetime information")
		},
		async ({ url }: { url: string }) => {
			try {
				// Import the utility function
				const { guessDatetimeFromUrl } = await import("../utils/guess-datetime.js");

				// Analyze the URL for datetime information
				const result = await guessDatetimeFromUrl(url);

				return {
					content: [{ type: "text" as const, text: yamlStringify(result) }],
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Screenshot tool - captures web page screenshots
	server.tool(
		"capture_screenshot_url",
		"Capture high-quality screenshots of web pages in base64 encoded JPEG format. Use this tool when you need to visually inspect a website, take a snapshot for analysis, or show users what a webpage looks like.",
		{
			url: z.string().url().describe("The complete HTTP/HTTPS URL of the webpage to capture (e.g., 'https://example.com')"),
			firstScreenOnly: z.boolean().default(false).describe("Set to true for a single screen capture (faster), false for full page capture including content below the fold"),
			return_url: z.boolean().default(false).describe("Set to true to return screenshot URLs instead of downloading images as base64")
		},
		async ({ url, firstScreenOnly, return_url }: { url: string; firstScreenOnly: boolean; return_url: boolean }) => {
			try {
				const props = getProps();
				const headers: Record<string, string> = {
					'Accept': 'application/json',
					'Content-Type': 'application/json',
					'X-Return-Format': firstScreenOnly === true ? 'screenshot' : 'pageshot',
				};

				// Add Authorization header if bearer token is available
				if (props.bearerToken) {
					headers['Authorization'] = `Bearer ${props.bearerToken}`;
				}

				const response = await fetch('https://r.jina.ai/', {
					method: 'POST',
					headers,
					body: JSON.stringify({ url }),
				});

				if (!response.ok) {
					return handleApiError(response, "Screenshot capture");
				}

				const data = await response.json() as any;

				// Get the screenshot URL from the response
				const imageUrl = data.data.screenshotUrl || data.data.pageshotUrl;
				if (!imageUrl) {
					throw new Error("No screenshot URL received from API");
				}

				// Prepare response content - always return as list structure for consistency
				const contentItems: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

				if (return_url) {
					// Return the URL as text
					contentItems.push({
						type: "text" as const,
						text: imageUrl,
					});
				} else {
					// Download and process the image (resize to max 800px, convert to JPEG)
					const processedResults = await downloadImages(imageUrl, 1, 10000);
					const processedResult = processedResults[0];

					if (!processedResult.success) {
						throw new Error(`Failed to process screenshot: ${processedResult.error}`);
					}

					contentItems.push({
						type: "image" as const,
						data: processedResult.data!,
						mimeType: "image/jpeg",
					});
				}

				return {
					content: contentItems,
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Read URL tool - converts any URL to markdown via r.jina.ai
	server.tool(
		"read_url",
		"Extract and convert web page content to clean, readable markdown format. Perfect for reading articles, documentation, blog posts, or any web content. Use this when you need to analyze text content from websites, bypass paywalls, or get structured data. 💡 Tip: Use `parallel_read_url` if you need to read multiple web pages simultaneously.",
		{
			url: z.string().url().describe("The complete URL of the webpage or PDF file to read and convert (e.g., 'https://example.com/article')"),
			withAllLinks: z.boolean().optional().describe("Set to true to extract and return all hyperlinks found on the page as structured data"),
			withAllImages: z.boolean().optional().describe("Set to true to extract and return all images found on the page as structured data")
		},
		async ({ url, withAllLinks, withAllImages }: { url: string; withAllLinks?: boolean; withAllImages?: boolean }) => {
			try {
				const props = getProps();

				// Import the utility function
				const { readUrlFromConfig } = await import("../utils/read.js");

				// Use the shared utility function
				const result = await readUrlFromConfig({ url, withAllLinks: withAllLinks || false, withAllImages: withAllImages || false }, props.bearerToken);

				if ('error' in result) {
					return createErrorResponse(result.error);
				}

				return {
					content: [{
						type: "text" as const,
						text: yamlStringify(result.structuredData),
					}],
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Search Web tool - search the web using Jina Search API
	server.tool(
		"search_web",
		"Search the entire web for current information, news, articles, and websites. Use this when you need up-to-date information, want to find specific websites, research topics, or get the latest news. Ideal for answering questions about recent events, finding resources, or discovering relevant content. 💡 Tip: Use `parallel_search_web` if you need to run multiple searches simultaneously.",
		{
			query: z.string().describe("Search terms or keywords to find relevant web content (e.g., 'climate change news 2024', 'best pizza recipe')"),
			num: z.number().default(30).describe("Maximum number of search results to return, between 1-100"),
			tbs: z.string().optional().describe("Time-based search parameter, e.g., 'qdr:h' for past hour, can be qdr:h, qdr:d, qdr:w, qdr:m, qdr:y"),
			location: z.string().optional().describe("Location for search results, e.g., 'London', 'New York', 'Tokyo'"),
			gl: z.string().optional().describe("Country code, e.g., 'dz' for Algeria"),
			hl: z.string().optional().describe("Language code, e.g., 'zh-cn' for Simplified Chinese")
		},
		async ({ query, num, tbs, location, gl, hl }: SearchWebArgs) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				const searchResult = await executeWebSearch({ query, num, tbs, location, gl, hl }, props.bearerToken);

				return {
					content: formatSingleSearchResultToContentItems(searchResult),
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Expand Query tool - expand search queries using Jina Search API
	server.tool(
		"expand_query",
		"Expand and rewrite search queries based on an up-to-date query expansion model. This tool takes an initial query and returns multiple expanded queries that can be used for more diversed and deeper searches. Useful for improving deep research results by searching broader and deeper.",
		{
			query: z.string().describe("The search query to expand (e.g., 'machine learning', 'climate change')")
		},
		async ({ query }: { query: string }) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				const response = await fetch('https://svip.jina.ai/', {
					method: 'POST',
					headers: {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${props.bearerToken}`,
					},
					body: JSON.stringify({
						q: query,
						query_expansion: true
					}),
				});

				if (!response.ok) {
					return handleApiError(response, "Query expansion");
				}

				const data = await response.json() as any;

				// Return each result as individual text items for consistency
				const contentItems: Array<{ type: 'text'; text: string }> = [];

				if (data.results && Array.isArray(data.results)) {
					for (const result of data.results) {
						contentItems.push({
							type: "text" as const,
							text: result,
						});
					}
				}

				return {
					content: contentItems,
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Search Arxiv tool - search arxiv papers using Jina Search API
	server.tool(
		"search_arxiv",
		"Search academic papers and preprints on arXiv repository. Perfect for finding research papers, scientific studies, technical papers, and academic literature. Use this when researching scientific topics, looking for papers by specific authors, or finding the latest research in fields like AI, physics, mathematics, computer science, etc. 💡 Tip: Use `parallel_search_arxiv` if you need to run multiple arXiv searches simultaneously.",
		{
			query: z.string().describe("Academic search terms, author names, or research topics (e.g., 'transformer neural networks', 'Einstein relativity', 'machine learning optimization')"),
			num: z.number().default(30).describe("Maximum number of academic papers to return, between 1-100"),
			tbs: z.string().optional().describe("Time-based search parameter, e.g., 'qdr:h' for past hour, can be qdr:h, qdr:d, qdr:w, qdr:m, qdr:y")
		},
		async ({ query, num, tbs }: SearchArxivArgs) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				const searchResult = await executeArxivSearch({ query, num, tbs }, props.bearerToken);

				return {
					content: formatSingleSearchResultToContentItems(searchResult),
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Search Images tool - search for images on the web using Jina Search API
	server.tool(
		"search_images",
		"Search for images across the web, similar to Google Images. Use this when you need to find photos, illustrations, diagrams, charts, logos, or any visual content. Perfect for finding images to illustrate concepts, locating specific pictures, or discovering visual resources. Images are returned by default as small base64-encoded JPEG images.",
		{
			query: z.string().describe("Image search terms describing what you want to find (e.g., 'sunset over mountains', 'vintage car illustration', 'data visualization chart')"),
			return_url: z.boolean().default(false).describe("Set to true to return image URLs, title, shapes, and other metadata. By default, images are downloaded as base64 and returned as rendered images."),
			tbs: z.string().optional().describe("Time-based search parameter, e.g., 'qdr:h' for past hour, can be qdr:h, qdr:d, qdr:w, qdr:m, qdr:y"),
			location: z.string().optional().describe("Location for search results, e.g., 'London', 'New York', 'Tokyo'"),
			gl: z.string().optional().describe("Country code, e.g., 'dz' for Algeria"),
			hl: z.string().optional().describe("Language code, e.g., 'zh-cn' for Simplified Chinese")
		},
		async ({ query, return_url, tbs, location, gl, hl }: SearchImageArgs) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				const searchResult = await executeImageSearch({ query, return_url, tbs, location, gl, hl }, props.bearerToken);

				if ('error' in searchResult) {
					return createErrorResponse(searchResult.error);
				}

				const data = { results: searchResult.results };

				// Prepare response content - always return as list structure for consistency
				const contentItems: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

				if (return_url) {
					// Return each result as individual text items
					if (data.results && Array.isArray(data.results)) {
						for (const result of data.results) {
							contentItems.push({
								type: "text" as const,
								text: yamlStringify(result),
							});
						}
					}
				} else {
					// Extract image URLs from search results
					const imageUrls: string[] = [];
					if (data.results && Array.isArray(data.results)) {
						for (const result of data.results) {
							if (result.imageUrl) {
								imageUrls.push(result.imageUrl);
							}
						}
					}

					if (imageUrls.length === 0) {
						throw new Error("No image URLs found in search results");
					}

					// Download and process images (resize to max 800px, convert to JPEG)
					// 15 second timeout - returns partial results if timeout occurs
					const downloadResults = await downloadImages(imageUrls, 3, 15000);

					// Add successful downloads as images
					for (const result of downloadResults) {
						if (result.success && result.data) {
							contentItems.push({
								type: "image" as const,
								data: result.data,
								mimeType: result.mimeType,
							});
						}
					}


				}

				return {
					content: contentItems,
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Parallel Search Web tool - execute multiple web searches in parallel
	server.tool(
		"parallel_search_web",
		"Run multiple web searches in parallel for comprehensive topic coverage and diverse perspectives. For best results, provide multiple search queries that explore different aspects of your topic. You can use expand_query to help generate diverse queries, or create them yourself. 💡 Use this when you need to gather information from multiple search angles at once for efficiency.",
		{
			searches: z.array(z.object({
				query: z.string().describe("Search terms or keywords to find relevant web content"),
				num: z.number().default(30).describe("Maximum number of search results to return, between 1-100"),
				tbs: z.string().optional().describe("Time-based search parameter, e.g., 'qdr:h' for past hour"),
				location: z.string().optional().describe("Location for search results, e.g., 'London', 'New York', 'Tokyo'"),
				gl: z.string().optional().describe("Country code, e.g., 'dz' for Algeria"),
				hl: z.string().optional().describe("Language code, e.g., 'zh-cn' for Simplified Chinese")
			})).max(5).describe("Array of search configurations to execute in parallel (maximum 5 searches for optimal performance)"),
			timeout: z.number().default(30000).describe("Timeout in milliseconds for all searches")
		},
		async ({ searches, timeout }: { searches: SearchWebArgs[]; timeout: number }) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				const uniqueSearches = searches.filter((search, index, self) =>
					index === self.findIndex(s => s.query === search.query)
				);

				// Use the common web search function
				const webSearchFunction = async (searchArgs: SearchWebArgs) => {
					return executeWebSearch(searchArgs, props.bearerToken);
				};

				// Execute parallel searches using utility
				const results = await executeParallelSearches(uniqueSearches, webSearchFunction, { timeout });

				return {
					content: formatParallelSearchResultsToContentItems(results),
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Parallel Search Arxiv tool - execute multiple arXiv searches in parallel
	server.tool(
		"parallel_search_arxiv",
		"Run multiple arXiv searches in parallel for comprehensive research coverage and diverse academic angles. For best results, provide multiple search queries that explore different research angles and methodologies. You can use expand_query to help generate diverse queries, or create them yourself. 💡 Use this when you need to explore multiple research directions simultaneously for efficiency.",
		{
			searches: z.array(z.object({
				query: z.string().describe("Academic search terms, author names, or research topics"),
				num: z.number().default(30).describe("Maximum number of academic papers to return, between 1-100"),
				tbs: z.string().optional().describe("Time-based search parameter, e.g., 'qdr:h' for past hour")
			})).max(5).describe("Array of arXiv search configurations to execute in parallel (maximum 5 searches for optimal performance)"),
			timeout: z.number().default(30000).describe("Timeout in milliseconds for all searches")
		},
		async ({ searches, timeout }: { searches: SearchArxivArgs[]; timeout: number }) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				const uniqueSearches = searches.filter((search, index, self) =>
					index === self.findIndex(s => s.query === search.query)
				);

				// Use the common arXiv search function
				const arxivSearchFunction = async (searchArgs: SearchArxivArgs) => {
					return executeArxivSearch(searchArgs, props.bearerToken);
				};

				// Execute parallel searches using utility
				const results = await executeParallelSearches(uniqueSearches, arxivSearchFunction, { timeout });

				return {
					content: formatParallelSearchResultsToContentItems(results),
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Parallel Read URL tool - execute multiple URL reads in parallel
	server.tool(
		"parallel_read_url",
		"Read multiple web pages in parallel to extract clean content efficiently. For best results, provide multiple URLs that you need to extract simultaneously. This is useful for comparing content across multiple sources or gathering information from multiple pages at once. 💡 Use this when you need to analyze multiple sources simultaneously for efficiency.",
		{
			urls: z.array(z.object({
				url: z.string().url().describe("The complete URL of the webpage or PDF file to read and convert"),
				withAllLinks: z.boolean().default(false).describe("Set to true to extract and return all hyperlinks found on the page as structured data"),
				withAllImages: z.boolean().default(false).describe("Set to true to extract and return all images found on the page as structured data")
			})).max(5).describe("Array of URL configurations to read in parallel (maximum 5 URLs for optimal performance)"),
			timeout: z.number().default(30000).describe("Timeout in milliseconds for all URL reads")
		},
		async ({ urls, timeout }: { urls: Array<{ url: string; withAllLinks: boolean; withAllImages: boolean }>; timeout: number }) => {
			try {
				const props = getProps();

				const uniqueUrls = urls.filter((urlConfig, index, self) =>
					index === self.findIndex(u => u.url === urlConfig.url)
				);

				// Import the utility functions
				const { executeParallelUrlReads } = await import("../utils/read.js");

				// Execute parallel URL reads using the utility
				const results = await executeParallelUrlReads(uniqueUrls, props.bearerToken, timeout);

				// Format results for consistent output
				const contentItems: Array<{ type: 'text'; text: string }> = [];

				for (const result of results) {
					if ('success' in result && result.success) {
						contentItems.push({
							type: "text" as const,
							text: yamlStringify(result.structuredData),
						});
					}
				}

				return {
					content: contentItems,
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Sort by relevance tool - rerank documents using Jina reranker API
	server.tool(
		"sort_by_relevance",
		"Rerank a list of documents by relevance to a query using Jina Reranker API. Use this when you have multiple documents and want to sort them by how well they match a specific query or topic. Perfect for document retrieval, content filtering, or finding the most relevant information from a collection.",
		{
			query: z.string().describe("The query or topic to rank documents against (e.g., 'machine learning algorithms', 'climate change solutions')"),
			documents: z.array(z.string()).describe("Array of document texts to rerank by relevance"),
			top_n: z.number().optional().describe("Maximum number of top results to return")
		},
		async ({ query, documents, top_n }: { query: string; documents: string[]; top_n?: number }) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				if (documents.length === 0) {
					throw new Error("No documents provided for reranking");
				}

				const response = await fetch('https://api.jina.ai/v1/rerank', {
					method: 'POST',
					headers: {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${props.bearerToken}`,
					},
					body: JSON.stringify({
						model: 'jina-reranker-v2-base-multilingual',
						query,
						top_n: top_n || documents.length,
						documents
					}),
				});

				if (!response.ok) {
					return handleApiError(response, "Document reranking");
				}

				const data = await response.json() as any;

				// Return each result as individual text items for consistency
				const contentItems: Array<{ type: 'text'; text: string }> = [];

				if (data.results && Array.isArray(data.results)) {
					for (const result of data.results) {
						contentItems.push({
							type: "text" as const,
							text: yamlStringify(result),
						});
					}
				}

				return {
					content: contentItems,
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Deduplicate strings tool - get top-k unique strings using embeddings and submodular optimization
	server.tool(
		"deduplicate_strings",
		"Get top-k semantically unique strings from a list using Jina embeddings and submodular optimization. Use this when you have many similar strings and want to select the most diverse subset that covers the semantic space. Perfect for removing duplicates, selecting representative samples, or finding diverse content.",
		{
			strings: z.array(z.string()).describe("Array of strings to deduplicate"),
			k: z.number().optional().describe("Number of unique strings to return. If not provided, automatically finds optimal k by looking at diminishing return")
		},
		async ({ strings, k }: { strings: string[]; k?: number }) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				if (strings.length === 0) {
					throw new Error("No strings provided for deduplication");
				}

				if (k !== undefined && (k <= 0 || k > strings.length)) {
					throw new Error(`Invalid k value: ${k}. Must be between 1 and ${strings.length}`);
				}

				// Get embeddings from Jina API
				const response = await fetch('https://api.jina.ai/v1/embeddings', {
					method: 'POST',
					headers: {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${props.bearerToken}`,
					},
					body: JSON.stringify({
						model: 'jina-embeddings-v3',
						task: 'text-matching',
						input: strings
					}),
				});

				if (!response.ok) {
					return handleApiError(response, "Getting embeddings");
				}

				const data = await response.json() as any;

				if (!data.data || !Array.isArray(data.data)) {
					throw new Error("Invalid response format from embeddings API");
				}

				// Extract embeddings
				const embeddings = data.data.map((item: any) => item.embedding);

				// Use submodular optimization to select diverse strings
				let selectedIndices: number[];
				let optimalK: number;
				let values: number[];

				if (k !== undefined) {
					// Use specified k
					selectedIndices = lazyGreedySelection(embeddings, k);
					values = [];
				} else {
					// Automatically find optimal k using saturation point
					const result = lazyGreedySelectionWithSaturation(embeddings);
					selectedIndices = result.selected;
					values = result.values;
				}

				// Get the selected strings
				const selectedStrings = selectedIndices.map(idx => ({
					index: idx,
					text: strings[idx]
				}));

				// Return each deduplicated string as individual text items for consistency
				const contentItems: Array<{ type: 'text'; text: string }> = [];

				for (const selectedString of selectedStrings) {
					contentItems.push({
						type: "text" as const,
						text: yamlStringify(selectedString),
					});
				}

				return {
					content: contentItems,
				};
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	// Deduplicate images tool - get top-k unique images using image embeddings and submodular optimization
	server.tool(
		"deduplicate_images",
		"Get top-k semantically unique images (URLs or base64-encoded) using Jina CLIP v2 embeddings and submodular optimization. Use this when you have many visually similar images and want the most diverse subset.",
		{
			images: z.array(z.string()).describe("Array of image inputs to deduplicate. Each item can be either an HTTP(S) URL or a raw base64-encoded image string (without data URI prefix)."),
			k: z.number().optional().describe("Number of unique images to return. If not provided, automatically finds optimal k by looking at diminishing return"),
		},
		async ({ images, k }: { images: string[]; k?: number }) => {
			try {
				const props = getProps();

				const tokenError = checkBearerToken(props.bearerToken);
				if (tokenError) {
					return tokenError;
				}

				if (images.length === 0) {
					throw new Error("No images provided for deduplication");
				}

				if (k !== undefined && (k <= 0 || k > images.length)) {
					throw new Error(`Invalid k value: ${k}. Must be between 1 and ${images.length}`);
				}

				// Prepare input for image embeddings API
				const embeddingInput = images.map((img) => ({ image: img }));

				// Get image embeddings from Jina API using CLIP v2
				const response = await fetch('https://api.jina.ai/v1/embeddings', {
					method: 'POST',
					headers: {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${props.bearerToken}`,
					},
					body: JSON.stringify({
						model: 'jina-clip-v2',
						input: embeddingInput,
					}),
				});

				if (!response.ok) {
					return handleApiError(response, "Getting image embeddings");
				}

				const data = await response.json() as any;

				if (!data.data || !Array.isArray(data.data)) {
					throw new Error("Invalid response format from embeddings API");
				}

				// Extract embeddings
				const embeddings = data.data.map((item: any) => item.embedding);

				// Use submodular optimization to select diverse images
				let selectedIndices: number[];
				let values: number[];

				if (k !== undefined) {
					selectedIndices = lazyGreedySelection(embeddings, k);
					values = [];
				} else {
					const result = lazyGreedySelectionWithSaturation(embeddings);
					selectedIndices = result.selected;
					values = result.values;
				}

				// Get the selected images
				const selectedImages = selectedIndices.map((idx) => ({ index: idx, source: images[idx] }));


				// Use our consolidated downloadImages utility for consistency
				const urlsToDownload = selectedImages
					.filter(({ source }) => /^https?:\/\//i.test(source))
					.map(({ source }) => source);

				const base64Images = selectedImages
					.filter(({ source }) => !/^https?:\/\//i.test(source))
					.map(({ source }) => source);

				const contentItems: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];

				// Download URLs using our utility
				if (urlsToDownload.length > 0) {
					const downloadResults = await downloadImages(urlsToDownload, 3, 15000);

					for (let i = 0; i < downloadResults.length; i++) {
						const result = downloadResults[i];
						const selectedImage = selectedImages.find(({ source }) => source === urlsToDownload[i]);

						if (result.success && result.data) {
							contentItems.push({
								type: 'image' as const,
								data: result.data,
								mimeType: result.mimeType,
							});
						} else {
							contentItems.push({
								type: 'text' as const,
								text: `Failed to download image at index ${selectedImage?.index || i}: ${result.error || 'Unknown error'}`,
							});
						}
					}
				}

				// Add base64 images directly
				for (const base64Image of base64Images) {
					contentItems.push({
						type: 'image' as const,
						data: base64Image,
						mimeType: 'image/jpeg', // Our utility converts to JPEG
					});
				}

				if (contentItems.length === 0) {
					throw new Error("No images to return after deduplication");
				}

				return { content: contentItems };
			} catch (error) {
				return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);
}
