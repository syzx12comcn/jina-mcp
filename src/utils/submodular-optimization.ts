// Submodular optimization utilities for string deduplication

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeMarginalGainDiversity(
    newIdx: number,
    currentCoverage: number[],
    similarityMatrix: number[][]
): number {
    const n = similarityMatrix.length;
    let marginalGain = 0;
    const row = similarityMatrix[newIdx];
    for (let i = 0; i < n; i++) {
        const newCoverage = row[i] > currentCoverage[i] ? row[i] : currentCoverage[i];
        marginalGain += newCoverage - currentCoverage[i];
    }
    return marginalGain;
}

export function lazyGreedySelection(embeddings: number[][], k: number): number[] {
    const n = embeddings.length;
    if (k >= n) return Array.from({ length: n }, (_, i) => i);

    const selected: number[] = [];
    const remaining = new Set(Array.from({ length: n }, (_, i) => i));

    // Pre-compute similarity matrix
    const similarityMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
        similarityMatrix[i] = [];
        for (let j = 0; j < n; j++) {
            // Clamp to non-negative to ensure monotone submodularity of facility-location objective
            const sim = cosineSimilarity(embeddings[i], embeddings[j]);
            similarityMatrix[i][j] = sim > 0 ? sim : 0;
        }
    }

    // Maintain current coverage vector (max similarity to selected set for each element)
    const currentCoverage = new Array(n).fill(0);

    // Priority queue implementation using array (simplified)
    const pq: Array<[number, number, number]> = [];

    // Initialize priority queue
    for (let i = 0; i < n; i++) {
        const gain = computeMarginalGainDiversity(i, currentCoverage, similarityMatrix);
        pq.push([-gain, 0, i]);
    }

    // Sort by gain (descending)
    pq.sort((a, b) => a[0] - b[0]);

    for (let iteration = 0; iteration < k; iteration++) {
        while (pq.length > 0) {
            const [negGain, lastUpdated, bestIdx] = pq.shift()!;

            if (!remaining.has(bestIdx)) continue;

            if (lastUpdated === iteration) {
                selected.push(bestIdx);
                remaining.delete(bestIdx);
                // Update coverage in O(n)
                const row = similarityMatrix[bestIdx];
                for (let i = 0; i < n; i++) {
                    if (row[i] > currentCoverage[i]) currentCoverage[i] = row[i];
                }
                break;
            }

            const currentGain = computeMarginalGainDiversity(bestIdx, currentCoverage, similarityMatrix);
            pq.push([-currentGain, iteration, bestIdx]);
            pq.sort((a, b) => a[0] - b[0]);
        }
    }

    return selected;
}

export function lazyGreedySelectionWithSaturation(
    embeddings: number[][],
    threshold: number = 1e-2
): { selected: number[], optimalK: number, values: number[] } {
    const n = embeddings.length;

    const selected: number[] = [];
    const remaining = new Set(Array.from({ length: n }, (_, i) => i));
    const values: number[] = [];

    // Pre-compute similarity matrix
    const similarityMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
        similarityMatrix[i] = [];
        for (let j = 0; j < n; j++) {
            const sim = cosineSimilarity(embeddings[i], embeddings[j]);
            similarityMatrix[i][j] = sim > 0 ? sim : 0;
        }
    }

    const currentCoverage = new Array(n).fill(0);

    // Priority queue implementation using array (simplified)
    const pq: Array<[number, number, number]> = [];

    // Initialize priority queue
    for (let i = 0; i < n; i++) {
        const gain = computeMarginalGainDiversity(i, currentCoverage, similarityMatrix);
        pq.push([-gain, 0, i]);
    }

    // Sort by gain (descending)
    pq.sort((a, b) => a[0] - b[0]);

    let earlyStopK: number | null = null;
    for (let iteration = 0; iteration < n; iteration++) {
        while (pq.length > 0) {
            const [negGain, lastUpdated, bestIdx] = pq.shift()!;

            if (!remaining.has(bestIdx)) continue;

            if (lastUpdated === iteration) {
                selected.push(bestIdx);
                remaining.delete(bestIdx);

                // Compute current function value (coverage)
                const row = similarityMatrix[bestIdx];
                for (let i = 0; i < n; i++) {
                    if (row[i] > currentCoverage[i]) currentCoverage[i] = row[i];
                }
                const functionValue = currentCoverage.reduce((sum, val) => sum + val, 0) / n;
                values.push(functionValue);

                // Early stop when the marginal gain (delta of normalized objective) falls below threshold
                if (values.length >= 2) {
                    const delta = values[values.length - 1] - values[values.length - 2];
                    if (delta < threshold) {
                        earlyStopK = values.length; // k is count of selected items
                    }
                }

                break;
            }

            const currentGain = computeMarginalGainDiversity(bestIdx, currentCoverage, similarityMatrix);
            pq.push([-currentGain, iteration, bestIdx]);
            pq.sort((a, b) => a[0] - b[0]);
        }
        if (earlyStopK !== null) break;
    }

    // Choose k: prefer early stop detection; otherwise, use all collected values
    const optimalK = earlyStopK ?? values.length;
    const finalSelected = selected.slice(0, optimalK);

    return { selected: finalSelected, optimalK, values };
}
