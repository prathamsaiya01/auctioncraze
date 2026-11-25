export function formatLakhs(lakhs: number): string {
  if (lakhs >= 100) {
    const crores = lakhs / 100;
    return `₹${Number.isInteger(crores) ? crores.toFixed(0) : crores.toFixed(2).replace(/0$/, '')} Cr`;
  }
  return `₹${lakhs} L`;
}
