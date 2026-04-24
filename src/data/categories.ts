export type Category = {
  id: string;
  title: string;
  emoji: string;
};

/** Swipe + Places text-query labels (not sample restaurant data). */
export const categories: Category[] = [
  { id: "pizza", title: "Pizza", emoji: "🍕" },
  { id: "burgers", title: "Fast Food", emoji: "🍔" },
  { id: "italian", title: "Italian", emoji: "🍝" },
  { id: "sushi", title: "Sushi", emoji: "🍣" },
  { id: "mexican", title: "Mexican", emoji: "🌮" },
  { id: "healthy", title: "Healthy", emoji: "🥗" },
  { id: "seafood", title: "Seafood", emoji: "🦐" },
  { id: "indian", title: "Indian", emoji: "🍛" },
  { id: "thai", title: "Thai", emoji: "🍜" },
  { id: "korean", title: "Korean", emoji: "🥘" },
  { id: "cafe", title: "Café & bakery", emoji: "☕" },
  { id: "bbq", title: "BBQ & grill", emoji: "🍖" },
];
