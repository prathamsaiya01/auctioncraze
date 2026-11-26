export function formatLakhs(lakhs: number): string {
  if (lakhs >= 100) {
    const crores = lakhs / 100;
    return `₹${Number.isInteger(crores) ? crores.toFixed(0) : crores.toFixed(2).replace(/0$/, '')} Cr`;
  }
  return `₹${lakhs} L`;
}

export function formatCricketStyle(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  if (raw === 'NONE') return 'None';
  return raw
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
