export const MAX_TITLE_LENGTH = 100;
export const MAX_URL_LENGTH = 2048;
export const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Basic URL format validation — must start with http:// or https://
 */
export const URL_RE = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*)+.*$/;

export const VALID_LINK_TYPES = ['manual', 'site_home', 'site_novel'] as const;
export type LinkType = (typeof VALID_LINK_TYPES)[number];

export function isValidLinkType(value: string): value is LinkType {
  return (VALID_LINK_TYPES as readonly string[]).includes(value);
}
