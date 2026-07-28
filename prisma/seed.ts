import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// A small starter database of retail barcodes (UPC-A / EAN-13). Prices in cents.
// This stands in for the "database of retail barcodes" and is what the "local"
// barcode provider searches before (optionally) falling back to an online lookup.
const PRODUCTS = [
  { barcode: "0049000042566", name: "Coca-Cola Classic 20oz", brand: "Coca-Cola", category: "Beverages", price: 219 },
  { barcode: "0012000001291", name: "Pepsi Cola 20oz", brand: "Pepsi", category: "Beverages", price: 209 },
  { barcode: "0038000138416", name: "Pringles Original 5.2oz", brand: "Pringles", category: "Snacks", price: 199 },
  { barcode: "0028400090889", name: "Doritos Nacho Cheese 9.25oz", brand: "Doritos", category: "Snacks", price: 449 },
  { barcode: "0044000032210", name: "Oreo Original 14.3oz", brand: "Nabisco", category: "Snacks", price: 399 },
  { barcode: "0037000138334", name: "Duracell AA Batteries 4pk", brand: "Duracell", category: "Hardware", price: 699 },
  { barcode: "0885909950355", name: "USB-C Charging Cable 6ft", brand: "Generic", category: "Electronics", price: 1299 },
  { barcode: "0072785100015", name: "Sharpie Fine Point Black", brand: "Sharpie", category: "Office", price: 179 },
  { barcode: "0076174517644", name: "Duct Tape 1.88in x 60yd", brand: "3M", category: "Hardware", price: 899 },
  { barcode: "0016000275287", name: "Nature Valley Granola Bars 12ct", brand: "Nature Valley", category: "Snacks", price: 549 },
  { barcode: "0300450449108", name: "Advil 200mg 50ct", brand: "Advil", category: "Pharmacy", price: 899 },
  { barcode: "0011110858573", name: "Bottled Water 24pk", brand: "Great Value", category: "Beverages", price: 399 },
];

async function main() {
  // Demo account so the app is usable immediately.
  const passwordHash = await bcrypt.hash("password123", 10);
  const user = await prisma.user.upsert({
    where: { email: "demo@amreceipts.app" },
    update: {},
    create: {
      email: "demo@amreceipts.app",
      name: "Demo User",
      passwordHash,
    },
  });

  await prisma.job.upsert({
    where: { userId_number: { userId: user.id, number: "JOB-1001" } },
    update: {},
    create: { userId: user.id, number: "JOB-1001", name: "Downtown site fit-out" },
  });

  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { barcode: p.barcode },
      update: { name: p.name, brand: p.brand, category: p.category, price: p.price },
      create: p,
    });
  }

  console.log(`Seeded ${PRODUCTS.length} products and demo user demo@amreceipts.app / password123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
