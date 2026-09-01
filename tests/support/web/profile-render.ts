interface BusinessProfile { displayName: string; businessHours: string; }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
export const renderProfile = (profile: BusinessProfile) => `<main><h1>Información del negocio</h1><dl><dt>Nombre comercial</dt><dd>${escapeHtml(profile.displayName)}</dd><dt>Horarios</dt><dd>${escapeHtml(profile.businessHours)}</dd></dl></main>`;
