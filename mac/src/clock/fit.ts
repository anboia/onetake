// Ajustes de reta usados na sincronia (S7): Theil-Sen para θ(t) = a + b·t (item 2) e mínimos
// quadrados para V = α + (1+β)·P (item 4). Só aritmética: sem processo, sem E/S.

/** Ponto do ajuste; `group` separa amostras que não informam inclinação entre si (mesma rajada). */
export interface XY {
  x: number;
  y: number;
  group?: number;
}

export interface Line {
  slope: number;
  intercept: number;
}

/** Mediana (média dos dois do meio quando a quantidade é par). Lista vazia é erro de uso. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mediana de lista vazia');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Theil-Sen: inclinação = mediana das inclinações de todos os pares com x diferentes e de grupos
 * diferentes (pares da mesma rajada, a 10 ms um do outro, só trazem ruído); intercepto = mediana de
 * y − inclinação·x. Sem nenhum par válido, devolve `null`.
 */
export function theilSen(points: readonly XY[]): Line | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    for (let j = i + 1; j < points.length; j++) {
      const q = points[j]!;
      if (q.x === p.x) continue;
      if (p.group !== undefined && p.group === q.group) continue;
      slopes.push((q.y - p.y) / (q.x - p.x));
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  return { slope, intercept: median(points.map((p) => p.y - slope * p.x)) };
}

/** Mínimos quadrados ordinários (com x centrado). Precisa de ≥ 2 pontos com x diferentes. */
export function leastSquares(points: readonly XY[]): Line {
  if (points.length < 2) throw new RangeError(`ajuste com ${points.length} ponto(s): são precisos ≥ 2`);
  const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const my = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
  }
  if (sxx === 0) throw new RangeError('ajuste com todos os x iguais');
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}
