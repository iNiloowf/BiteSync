export type Category = {
  id: string;
  title: string;
  emoji: string;
  blurb: string;
  accent: string;
  textures: string;
};

export type MenuPreview = {
  id: string;
  title: string;
  image: string;
  price: string;
};

export type Restaurant = {
  id: string;
  name: string;
  categoryIds: string[];
  rating: number;
  reviewCount: number;
  eta: string;
  priceLevel: "$" | "$$" | "$$$";
  mapLabel: string;
  vibe: string;
  menuPreviews: MenuPreview[];
};

export type CountrySeed = {
  code: string;
  label: string;
  city: string;
  roomName: string;
  restaurants: Restaurant[];
};

export const categories: Category[] = [
  {
    id: "pizza",
    title: "Pizza",
    emoji: "🍕",
    blurb: "Cheesy, social, and perfect for group nights.",
    accent: "from-orange-300 via-amber-200 to-rose-200",
    textures: "shadow-[0_20px_60px_rgba(251,146,60,0.24)]",
  },
  {
    id: "burgers",
    title: "Fast Food",
    emoji: "🍔",
    blurb: "Smash burgers, loaded fries, and quick comfort food.",
    accent: "from-amber-300 via-yellow-200 to-lime-100",
    textures: "shadow-[0_20px_60px_rgba(251,191,36,0.24)]",
  },
  {
    id: "italian",
    title: "Italian",
    emoji: "🍝",
    blurb: "Pasta, creamy sauces, and shareable plates.",
    accent: "from-emerald-300 via-lime-100 to-stone-100",
    textures: "shadow-[0_20px_60px_rgba(52,211,153,0.22)]",
  },
  {
    id: "sushi",
    title: "Sushi",
    emoji: "🍣",
    blurb: "Clean flavors, premium rolls, and light bites.",
    accent: "from-cyan-300 via-sky-100 to-slate-100",
    textures: "shadow-[0_20px_60px_rgba(56,189,248,0.22)]",
  },
  {
    id: "mexican",
    title: "Mexican",
    emoji: "🌮",
    blurb: "Tacos, bowls, and bright spicy flavors.",
    accent: "from-red-300 via-orange-200 to-yellow-100",
    textures: "shadow-[0_20px_60px_rgba(248,113,113,0.24)]",
  },
  {
    id: "healthy",
    title: "Healthy",
    emoji: "🥗",
    blurb: "Fresh bowls, wraps, and lighter options.",
    accent: "from-lime-300 via-green-100 to-emerald-100",
    textures: "shadow-[0_20px_60px_rgba(132,204,22,0.24)]",
  },
  {
    id: "seafood",
    title: "Seafood",
    emoji: "🦐",
    blurb: "Fish, shellfish, oysters, and coastal flavors.",
    accent: "from-sky-300 via-cyan-100 to-teal-100",
    textures: "shadow-[0_20px_60px_rgba(34,211,238,0.22)]",
  },
  {
    id: "indian",
    title: "Indian",
    emoji: "🍛",
    blurb: "Curries, naan, tandoor, and bold spices.",
    accent: "from-amber-400 via-orange-200 to-yellow-100",
    textures: "shadow-[0_20px_60px_rgba(251,146,60,0.22)]",
  },
  {
    id: "thai",
    title: "Thai",
    emoji: "🍜",
    blurb: "Pad thai, curries, herbs, and sweet-sour heat.",
    accent: "from-emerald-400 via-lime-200 to-amber-100",
    textures: "shadow-[0_20px_60px_rgba(52,211,153,0.2)]",
  },
  {
    id: "korean",
    title: "Korean",
    emoji: "🥘",
    blurb: "BBQ grills, bibimbap, kimchi, and late-night comfort.",
    accent: "from-rose-300 via-red-100 to-orange-100",
    textures: "shadow-[0_20px_60px_rgba(251,113,133,0.22)]",
  },
  {
    id: "cafe",
    title: "Café & bakery",
    emoji: "☕",
    blurb: "Coffee, pastries, brunch, and slow mornings.",
    accent: "from-stone-300 via-amber-100 to-orange-50",
    textures: "shadow-[0_20px_60px_rgba(214,211,209,0.2)]",
  },
  {
    id: "bbq",
    title: "BBQ & grill",
    emoji: "🍖",
    blurb: "Smoked meats, ribs, and flame-kissed plates.",
    accent: "from-orange-400 via-red-200 to-stone-200",
    textures: "shadow-[0_20px_60px_rgba(248,113,113,0.22)]",
  },
];

export const participants = [
  { id: "host", name: "Mia", avatar: "M", mood: "Wants something easy" },
  { id: "1", name: "Noah", avatar: "N", mood: "Late-night comfort food" },
  { id: "2", name: "Ava", avatar: "A", mood: "Open to sushi" },
  { id: "3", name: "Leo", avatar: "L", mood: "No heavy meals tonight" },
];

export const countries: CountrySeed[] = [
  {
    code: "CA",
    label: "Canada",
    city: "Toronto",
    roomName: "Downtown Dinner Drop",
    restaurants: [
      {
        id: "north-slice",
        name: "North Slice Social",
        categoryIds: ["pizza", "italian"],
        rating: 4.7,
        reviewCount: 1240,
        eta: "18-25 min",
        priceLevel: "$$",
        mapLabel: "4.7 on Google Maps",
        vibe: "Wood-fired pies and creamy truffle rigatoni.",
        menuPreviews: [
          {
            id: "1",
            title: "Truffle Mushroom Pizza",
            image:
              "https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=900&q=80",
            price: "$21",
          },
          {
            id: "2",
            title: "Burrata Pomodoro",
            image:
              "https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?auto=format&fit=crop&w=900&q=80",
            price: "$18",
          },
        ],
      },
      {
        id: "metro-roll",
        name: "Metro Roll House",
        categoryIds: ["sushi", "healthy"],
        rating: 4.8,
        reviewCount: 890,
        eta: "20-30 min",
        priceLevel: "$$$",
        mapLabel: "4.8 on Google Maps",
        vibe: "Premium rolls, poke, and bright fresh sides.",
        menuPreviews: [
          {
            id: "1",
            title: "Salmon Sunset Roll",
            image:
              "https://images.unsplash.com/photo-1579871494447-9811cf80d66c?auto=format&fit=crop&w=900&q=80",
            price: "$17",
          },
          {
            id: "2",
            title: "Miso Poke Bowl",
            image:
              "https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=80",
            price: "$16",
          },
        ],
      },
      {
        id: "queen-street-smash",
        name: "Queen Street Smash",
        categoryIds: ["burgers", "mexican"],
        rating: 4.5,
        reviewCount: 1730,
        eta: "15-20 min",
        priceLevel: "$$",
        mapLabel: "4.5 on Google Maps",
        vibe: "Loaded burgers, curly fries, and taco specials.",
        menuPreviews: [
          {
            id: "1",
            title: "Double Smash Combo",
            image:
              "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=900&q=80",
            price: "$19",
          },
          {
            id: "2",
            title: "Street Corn Fries",
            image:
              "https://images.unsplash.com/photo-1518013431117-eb1465fa5752?auto=format&fit=crop&w=900&q=80",
            price: "$11",
          },
        ],
      },
    ],
  },
  {
    code: "US",
    label: "United States",
    city: "Denver",
    roomName: "Highline Bites",
    restaurants: [
      {
        id: "mile-high-pizza",
        name: "Mile High Pizza Club",
        categoryIds: ["pizza", "italian"],
        rating: 4.6,
        reviewCount: 980,
        eta: "20-28 min",
        priceLevel: "$$",
        mapLabel: "4.6 on Google Maps",
        vibe: "Crisp crust slices and cozy pasta trays.",
        menuPreviews: [
          {
            id: "1",
            title: "Hot Honey Pepperoni",
            image:
              "https://images.unsplash.com/photo-1594007654729-407eedc4be65?auto=format&fit=crop&w=900&q=80",
            price: "$20",
          },
          {
            id: "2",
            title: "Baked Alfredo Penne",
            image:
              "https://images.unsplash.com/photo-1645112411341-6c4fd023714a?auto=format&fit=crop&w=900&q=80",
            price: "$17",
          },
        ],
      },
      {
        id: "sora-sushi",
        name: "Sora Sushi & Bowls",
        categoryIds: ["sushi", "healthy"],
        rating: 4.9,
        reviewCount: 610,
        eta: "22-32 min",
        priceLevel: "$$$",
        mapLabel: "4.9 on Google Maps",
        vibe: "Beautiful rolls, clean flavors, and rice bowls.",
        menuPreviews: [
          {
            id: "1",
            title: "Dragon Crunch Roll",
            image:
              "https://images.unsplash.com/photo-1611143669185-af224c5e3252?auto=format&fit=crop&w=900&q=80",
            price: "$18",
          },
          {
            id: "2",
            title: "Sesame Tofu Bowl",
            image:
              "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=900&q=80",
            price: "$15",
          },
        ],
      },
      {
        id: "sunset-tacos",
        name: "Sunset Tacos",
        categoryIds: ["mexican", "burgers"],
        rating: 4.4,
        reviewCount: 1420,
        eta: "12-18 min",
        priceLevel: "$",
        mapLabel: "4.4 on Google Maps",
        vibe: "Late-night tacos, bowls, and loaded quesadillas.",
        menuPreviews: [
          {
            id: "1",
            title: "Birria Taco Trio",
            image:
              "https://images.unsplash.com/photo-1552332386-f8dd00dc2f85?auto=format&fit=crop&w=900&q=80",
            price: "$14",
          },
          {
            id: "2",
            title: "Chicken Quesadilla",
            image:
              "https://images.unsplash.com/photo-1615870216519-2f9fa575fa5c?auto=format&fit=crop&w=900&q=80",
            price: "$13",
          },
        ],
      },
    ],
  },
  {
    code: "AE",
    label: "United Arab Emirates",
    city: "Dubai",
    roomName: "Marina Matchup",
    restaurants: [
      {
        id: "marina-pizza",
        name: "Marina Pizza Atelier",
        categoryIds: ["pizza", "italian"],
        rating: 4.8,
        reviewCount: 1120,
        eta: "18-24 min",
        priceLevel: "$$",
        mapLabel: "4.8 on Google Maps",
        vibe: "Designer pizzas with polished presentation.",
        menuPreviews: [
          {
            id: "1",
            title: "Stracciatella Pizza",
            image:
              "https://images.unsplash.com/photo-1511689660979-10d2b1aada49?auto=format&fit=crop&w=900&q=80",
            price: "AED 68",
          },
          {
            id: "2",
            title: "Pesto Burrata Pasta",
            image:
              "https://images.unsplash.com/photo-1555949258-eb67b1ef0ceb?auto=format&fit=crop&w=900&q=80",
            price: "AED 59",
          },
        ],
      },
      {
        id: "wave-sushi",
        name: "Wave Sushi Lounge",
        categoryIds: ["sushi", "healthy"],
        rating: 4.7,
        reviewCount: 760,
        eta: "20-29 min",
        priceLevel: "$$$",
        mapLabel: "4.7 on Google Maps",
        vibe: "Stylish platters and light fusion bowls.",
        menuPreviews: [
          {
            id: "1",
            title: "Volcano Roll",
            image:
              "https://images.unsplash.com/photo-1582450871972-ab5ca7f8bfc4?auto=format&fit=crop&w=900&q=80",
            price: "AED 44",
          },
          {
            id: "2",
            title: "Crispy Salmon Bowl",
            image:
              "https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=900&q=80",
            price: "AED 39",
          },
        ],
      },
      {
        id: "desert-burger",
        name: "Desert Burger Lab",
        categoryIds: ["burgers", "mexican"],
        rating: 4.6,
        reviewCount: 1530,
        eta: "15-22 min",
        priceLevel: "$$",
        mapLabel: "4.6 on Google Maps",
        vibe: "Brioche burgers, crispy chicken, and spicy sides.",
        menuPreviews: [
          {
            id: "1",
            title: "Truffle Smash Burger",
            image:
              "https://images.unsplash.com/photo-1550317138-10000687a72b?auto=format&fit=crop&w=900&q=80",
            price: "AED 48",
          },
          {
            id: "2",
            title: "Chipotle Chicken Sliders",
            image:
              "https://images.unsplash.com/photo-1520072959219-c595dc870360?auto=format&fit=crop&w=900&q=80",
            price: "AED 35",
          },
        ],
      },
    ],
  },
];
