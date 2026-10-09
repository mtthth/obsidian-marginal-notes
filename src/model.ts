// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

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
	/** Repère « page cornée » : un endroit où revenir, qu'un paragraphe peut porter sans étiquette. */
	corner?: boolean;
	color?: string;
	text?: string;
}

// Un paragraphe étiqueté commence par "%%mn corne c=<clé> t=<texte>%% " ; le texte ne peut pas
// contenir "%" (filtré à la saisie) afin que la regex n'ait pas besoin d'échappement complexe.
// Le texte, qui avale les espaces, reste en dernier : les autres champs se glissent avant lui.
const MARKER_RE = /^%%mn(?:\s+(corne))?(?:\s+c=([a-zA-Z0-9_-]+))?(?:\s+t=([^%]*))?%%(?:\s|$)/;

/** Force la commande "recalcule tes marqueurs de gutter" côté vue CM6 (ex: après un changement de palette). */
export const refreshMarkersEffect = StateEffect.define<void>();

/** Une étiquette proprement dite — couleur ou texte —, par opposition au seul repère de page cornée. */
export function hasLabel(tag: ParagraphTag): boolean {
	return Boolean(tag.color || tag.text);
}

export function sanitizeLabel(text: string): string {
	return text.replace(/%/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Le marqueur en tête de `lineText`, s'il y en a un. Un marqueur vide (`%%mn t=%%`, qu'écrivaient les
 * versions jusqu'à 0.1.29 pour un texte fait d'espaces) est reconnu, avec une étiquette vide : il n'est
 * ni dessiné ni compté, mais la prochaine écriture le remplace au lieu d'en empiler un autre devant.
 */
export function parseMarker(lineText: string): { tag: ParagraphTag; matchLength: number } | null {
	const m = MARKER_RE.exec(lineText);
	if (!m) return null;
	const tag: ParagraphTag = {};
	if (m[1]) tag.corner = true;
	if (m[2]) tag.color = m[2];
	if (m[3]) {
		const text = m[3].trim();
		if (text) tag.text = text;
	}
	return { tag, matchLength: m[0].length };
}

export function encodeMarker(tag: ParagraphTag): string {
	// Le texte nettoyé d'abord : fait d'espaces ou de « % », il n'en reste rien, et il ne doit pas
	// suffire à écrire un marqueur.
	const text = tag.text ? sanitizeLabel(tag.text) : "";
	if (!tag.corner && !tag.color && !text) return "";
	let inner = "mn";
	if (tag.corner) inner += " corne";
	if (tag.color) inner += ` c=${tag.color}`;
	if (text) inner += ` t=${text}`;
	return `%%${inner}%% `;
}
