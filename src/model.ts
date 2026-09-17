import { StateEffect } from "@codemirror/state";

export interface PaletteColor {
	key: string;
	label: string;
	color: string;
}

export const DEFAULT_PALETTE: PaletteColor[] = [
	{ key: "rouge", label: "À retravailler", color: "#e74c3c" },
	{ key: "ambre", label: "En cours", color: "#f39c12" },
	{ key: "vert", label: "Validé", color: "#2ecc71" },
	{ key: "bleu", label: "Idée à explorer", color: "#3498db" },
	{ key: "violet", label: "Recherche", color: "#9b59b6" },
];

export interface ParagraphTag {
	color?: string;
	text?: string;
}

// Un paragraphe étiqueté commence par "%%mn c=<clé> t=<texte>%% " ; le texte ne peut pas
// contenir "%" (filtré à la saisie) afin que la regex n'ait pas besoin d'échappement complexe.
const MARKER_RE = /^%%mn(?:\s+c=([a-zA-Z0-9_-]+))?(?:\s+t=([^%]*))?%%(?:\s|$)/;

/** Force la commande "recalcule tes marqueurs de gutter" côté vue CM6 (ex: après un changement de palette). */
export const refreshMarkersEffect = StateEffect.define<void>();

export function sanitizeLabel(text: string): string {
	return text.replace(/%/g, "").replace(/\s+/g, " ").trim();
}

export function parseMarker(lineText: string): { tag: ParagraphTag; matchLength: number } | null {
	const m = MARKER_RE.exec(lineText);
	if (!m) return null;
	const tag: ParagraphTag = {};
	if (m[1]) tag.color = m[1];
	if (m[2]) {
		const text = m[2].trim();
		if (text) tag.text = text;
	}
	if (!tag.color && !tag.text) return null;
	return { tag, matchLength: m[0].length };
}

export function encodeMarker(tag: ParagraphTag): string {
	if (!tag.color && !tag.text) return "";
	let inner = "mn";
	if (tag.color) inner += ` c=${tag.color}`;
	if (tag.text) inner += ` t=${sanitizeLabel(tag.text)}`;
	return `%%${inner}%% `;
}
