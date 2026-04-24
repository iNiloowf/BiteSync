export type CountryOption = {
  code: string;
  label: string;
};

/** ISO-3166 alpha-2 codes for signup / profile (no demo content). */
export const countries: CountryOption[] = [
  { code: "AE", label: "United Arab Emirates" },
  { code: "AU", label: "Australia" },
  { code: "CA", label: "Canada" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "GB", label: "United Kingdom" },
  { code: "IN", label: "India" },
  { code: "JP", label: "Japan" },
  { code: "KR", label: "South Korea" },
  { code: "MX", label: "Mexico" },
  { code: "US", label: "United States" },
].sort((a, b) => a.label.localeCompare(b.label));
