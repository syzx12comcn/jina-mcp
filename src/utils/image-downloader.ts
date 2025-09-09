/**
 * Image downloader utility with queue system for handling multiple concurrent downloads
 * Uses Cloudflare Workers' built-in image transformation capabilities
 */

interface ProcessedImageResult {
    url: string;
    success: boolean;
    data?: string; // base64 encoded JPEG image
    mimeType: string; // always "image/jpeg"
    error?: string;
}

/**
 * Download and process images using Cloudflare Workers image transformation
 * Automatically resizes to max 800px longest edge and converts to JPEG
 * Handles both single and batch downloads with timeout support
 */
export async function downloadImages(
    urls: string | string[],
    concurrencyLimit: number = 3,
    timeoutMs: number = 15000
): Promise<ProcessedImageResult[]> {
    // Normalize input to always be an array
    const urlArray = Array.isArray(urls) ? urls : [urls];

    if (urlArray.length === 0) {
        return [];
    }

    const results: ProcessedImageResult[] = [];
    const queue = [...urlArray];

    // Create a timeout promise
    const timeoutPromise = new Promise<ProcessedImageResult[]>((_, reject) => {
        setTimeout(() => reject(new Error('Download timeout')), timeoutMs);
    });

    // Create the download promise
    const downloadPromise = (async () => {
        // Process images in batches
        while (queue.length > 0) {
            const batch = queue.splice(0, concurrencyLimit);
            const batchPromises = batch.map(async (url) => {
                try {
                    // Skip SVG images as they can't be processed by Cloudflare image transformation
                    if (url.toLowerCase().endsWith('.svg') || url.toLowerCase().includes('.svg?')) {
                        return {
                            url,
                            success: false,
                            mimeType: "image/jpeg",
                            error: "SVG images are not supported for transformation"
                        };
                    }

                    // Use Cloudflare Workers image transformation
                    // This automatically handles resizing and format conversion
                    const response = await fetch(url, {
                        cf: {
                            image: {
                                fit: 'scale-down', // Never enlarge, only shrink
                                width: 800,        // Max width
                                height: 800,       // Max height
                                format: 'jpeg',    // Convert to JPEG
                                quality: 85,       // Good quality with reasonable file size
                                compression: 'fast' // Faster processing
                            }
                        }
                    } as any);

                    if (!response.ok) {
                        return {
                            url,
                            success: false,
                            mimeType: "image/jpeg",
                            error: `HTTP ${response.status}: ${response.statusText}`
                        };
                    }

                    const arrayBuffer = await response.arrayBuffer();
                    const base64Image = Buffer.from(arrayBuffer).toString('base64');

                    return {
                        url,
                        success: true,
                        data: base64Image,
                        mimeType: "image/jpeg"
                    };
                } catch (error) {
                    return {
                        url,
                        success: false,
                        mimeType: "image/jpeg",
                        error: error instanceof Error ? error.message : String(error)
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }

        return results;
    })();

    // Race between download completion and timeout
    try {
        return await Promise.race([downloadPromise, timeoutPromise]);
    } catch (error) {
        if (error instanceof Error && error.message === 'Download timeout') {
            // Return what we have so far
            return results;
        }
        throw error;
    }
}
