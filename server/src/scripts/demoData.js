// Demo catalog for `npm run seed:demo`. Plain data only, so tests can check it without a server.
// Money is integer paise (D5). SKUs are unique per vendor (DATABASE_SCHEMA products).

export const DEMO_PASSWORD = 'DemoPass123'; // 10-72 chars with a letter and a digit (auth rule)

export const DEMO_CUSTOMER = { name: 'Demo Customer', email: 'customer@demo.example' };

export const DEMO_CATEGORIES = [
  { key: 'clothing', name: 'Clothing', children: [{ key: 'kurtas', name: 'Kurtas' }] },
  { key: 'home', name: 'Home & Kitchen', children: [{ key: 'kitchen', name: 'Kitchenware' }] },
  { key: 'accessories', name: 'Accessories', children: [] },
];

export const DEMO_VENDORS = [
  {
    email: 'loom@demo.example',
    name: 'Loom Owner',
    shopName: 'Loom & Co',
    description: 'Handwoven essentials',
    products: [
      {
        sku: 'LOOM-001',
        title: 'Handloom Cotton Kurta',
        description: 'Soft handloom cotton kurta, breathable and easy to wash.',
        category: 'kurtas',
        pricePaise: 149900,
        stockQty: 40,
      },
      {
        sku: 'LOOM-002',
        title: 'Block Print Cotton Kurta',
        description: 'Hand block printed kurta in a relaxed fit.',
        category: 'kurtas',
        pricePaise: 189900,
        stockQty: 25,
      },
      {
        sku: 'LOOM-003',
        title: 'Handwoven Cotton Scarf',
        description: 'Lightweight woven scarf in natural dyes.',
        category: 'accessories',
        pricePaise: 59900,
        stockQty: 60,
      },
    ],
  },
  {
    email: 'copper@demo.example',
    name: 'Copper Owner',
    shopName: 'Copper Kitchen',
    description: 'Cookware for everyday cooking',
    products: [
      {
        sku: 'COPR-001',
        title: 'Hammered Copper Water Bottle',
        description: 'One litre copper bottle with a leak-proof cap.',
        category: 'kitchen',
        pricePaise: 79900,
        stockQty: 50,
      },
      {
        sku: 'COPR-002',
        title: 'Cast Iron Skillet 10 inch',
        description: 'Pre-seasoned skillet that works on gas and induction.',
        category: 'kitchen',
        pricePaise: 219900,
        stockQty: 15,
      },
      {
        sku: 'COPR-003',
        title: 'Teak Serving Board',
        description: 'Solid teak board with a juice groove.',
        category: 'home',
        pricePaise: 99900,
        stockQty: 30,
      },
    ],
  },
  {
    email: 'leaf@demo.example',
    name: 'Leaf Owner',
    shopName: 'Leaf & Thread',
    description: 'Natural-fibre bags and homeware',
    products: [
      {
        sku: 'LEAF-001',
        title: 'Jute Tote Bag',
        description: 'Roomy jute tote with a cotton lining.',
        category: 'accessories',
        pricePaise: 49900,
        stockQty: 80,
      },
      {
        sku: 'LEAF-002',
        title: 'Cotton Table Runner',
        description: 'Woven table runner, 180 cm long.',
        category: 'home',
        pricePaise: 69900,
        stockQty: 35,
      },
    ],
  },
];

// A platform coupon (admin-created, platform-funded: D6). Dates are filled in by the script.
export const DEMO_COUPON = {
  code: 'WELCOME10',
  type: 'percent',
  value: 10,
  minOrderPaise: 50000,
  maxDiscountPaise: 20000,
  usageLimitPerUser: 1,
};
