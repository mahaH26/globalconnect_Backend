export const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");
export const isValidName = (s: string) => s.length >= 2 && s.length <= 60;
export const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
