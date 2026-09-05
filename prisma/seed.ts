import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// A starter catalogue of retail barcodes (UPC-A), weighted toward Home Depot and
// other hardware/building-supply vendors. Prices are in cents and are indicative
// shelf prices only.
//
// NOTE: these barcodes are illustrative sample data for local lookup and demos.
// They are not guaranteed to match manufacturer-assigned GTINs. Enable the
// online barcode provider (BARCODE_PROVIDER=upcitemdb) to resolve real-world
// barcodes not present here; results are cached back into this table.

interface SeedProduct {
  barcode: string;
  name: string;
  brand: string;
  category: string;
  price: number; // cents
}

// Keep these general-merchandise items: the offline OCR stub references them so
// receipt <-> barcode linking is demonstrable out of the box.
const GENERAL: SeedProduct[] = [
  { barcode: "0049000042566", name: "Coca-Cola Classic 20oz", brand: "Coca-Cola", category: "Beverages", price: 219 },
  { barcode: "0012000001291", name: "Pepsi Cola 20oz", brand: "Pepsi", category: "Beverages", price: 209 },
  { barcode: "0038000138416", name: "Pringles Original 5.2oz", brand: "Pringles", category: "Snacks", price: 199 },
  { barcode: "0028400090889", name: "Doritos Nacho Cheese 9.25oz", brand: "Doritos", category: "Snacks", price: 449 },
  { barcode: "0044000032210", name: "Oreo Original 14.3oz", brand: "Nabisco", category: "Snacks", price: 399 },
  { barcode: "0037000138334", name: "Duracell AA Batteries 4pk", brand: "Duracell", category: "Batteries", price: 699 },
  { barcode: "0885909950355", name: "USB-C Charging Cable 6ft", brand: "Generic", category: "Electronics", price: 1299 },
  { barcode: "0072785100015", name: "Sharpie Fine Point Black", brand: "Sharpie", category: "Office", price: 179 },
  { barcode: "0076174517644", name: "Duct Tape 1.88in x 60yd", brand: "3M", category: "Adhesives & Tape", price: 899 },
  { barcode: "0016000275287", name: "Nature Valley Granola Bars 12ct", brand: "Nature Valley", category: "Snacks", price: 549 },
  { barcode: "0300450449108", name: "Advil 200mg 50ct", brand: "Advil", category: "Pharmacy", price: 899 },
  { barcode: "0011110858573", name: "Bottled Water 24pk", brand: "Great Value", category: "Beverages", price: 399 },
];

// ---- Power tools ----------------------------------------------------------
const POWER_TOOLS: SeedProduct[] = [
  { barcode: "0885911703536", name: "DEWALT 20V MAX Cordless Drill/Driver Kit", brand: "DEWALT", category: "Power Tools", price: 15900 },
  { barcode: "0885911641098", name: "DEWALT 20V MAX 1/4in Impact Driver (Tool Only)", brand: "DEWALT", category: "Power Tools", price: 11900 },
  { barcode: "0045242551545", name: "Milwaukee M18 FUEL Hammer Drill Kit", brand: "Milwaukee", category: "Power Tools", price: 19900 },
  { barcode: "0045242401123", name: "Milwaukee M18 FUEL 1/2in Impact Wrench", brand: "Milwaukee", category: "Power Tools", price: 24900 },
  { barcode: "0088381098762", name: "Makita 18V LXT Brushless Circular Saw", brand: "Makita", category: "Power Tools", price: 17900 },
  { barcode: "0088381687119", name: "Makita 18V LXT Reciprocating Saw", brand: "Makita", category: "Power Tools", price: 16900 },
  { barcode: "0033287209316", name: "RYOBI ONE+ 18V Cordless Drill Kit", brand: "RYOBI", category: "Power Tools", price: 7900 },
  { barcode: "0033287215881", name: "RYOBI ONE+ 18V Random Orbit Sander", brand: "RYOBI", category: "Power Tools", price: 5900 },
  { barcode: "0648846037592", name: "RIDGID 18V OCTANE Brushless Impact Driver", brand: "RIDGID", category: "Power Tools", price: 12900 },
  { barcode: "0000346717235", name: "Bosch 12V Max EC Brushless Drill/Driver", brand: "Bosch", category: "Power Tools", price: 9900 },
  { barcode: "0885911610643", name: "DEWALT 7-1/4in Corded Circular Saw 15A", brand: "DEWALT", category: "Power Tools", price: 9900 },
  { barcode: "0045242308668", name: "Milwaukee M12 FUEL Right Angle Drill", brand: "Milwaukee", category: "Power Tools", price: 17900 },
  { barcode: "0885911703215", name: "DEWALT 4.5in Angle Grinder 11A", brand: "DEWALT", category: "Power Tools", price: 6900 },
  { barcode: "0033287197644", name: "RYOBI 18V ONE+ Jig Saw (Tool Only)", brand: "RYOBI", category: "Power Tools", price: 5900 },
  { barcode: "0088381094443", name: "Makita 18V LXT Rotary Hammer SDS-Plus", brand: "Makita", category: "Power Tools", price: 29900 },
];

// ---- Hand tools -----------------------------------------------------------
const HAND_TOOLS: SeedProduct[] = [
  { barcode: "0037103305145", name: "Husky 16 oz Fiberglass Claw Hammer", brand: "Husky", category: "Hand Tools", price: 1497 },
  { barcode: "0037103278616", name: "Husky 25 ft Tape Measure", brand: "Husky", category: "Hand Tools", price: 999 },
  { barcode: "0092644630019", name: "Klein Tools 9in Lineman's Pliers", brand: "Klein Tools", category: "Hand Tools", price: 3497 },
  { barcode: "0092644752018", name: "Klein Tools 11-in-1 Screwdriver/Nut Driver", brand: "Klein Tools", category: "Hand Tools", price: 2297 },
  { barcode: "0076174114881", name: "Stanley FatMax 25 ft Tape Measure", brand: "Stanley", category: "Hand Tools", price: 1798 },
  { barcode: "0076174101157", name: "Stanley 10 in Adjustable Wrench", brand: "Stanley", category: "Hand Tools", price: 1497 },
  { barcode: "0037103257635", name: "Husky 100-Position Ratchet Set 40pc", brand: "Husky", category: "Hand Tools", price: 4900 },
  { barcode: "0034139049203", name: "Crescent 8 in Adjustable Wrench", brand: "Crescent", category: "Hand Tools", price: 1399 },
  { barcode: "0034139902102", name: "Crescent Locking Pliers 10in", brand: "Crescent", category: "Hand Tools", price: 1699 },
  { barcode: "0034114221012", name: "Estwing 16 oz Steel Claw Hammer", brand: "Estwing", category: "Hand Tools", price: 3299 },
  { barcode: "0037103200211", name: "Husky Utility Knife with 5 Blades", brand: "Husky", category: "Hand Tools", price: 799 },
  { barcode: "0076174868012", name: "Stanley 9in Torpedo Level", brand: "Stanley", category: "Hand Tools", price: 999 },
  { barcode: "0092644700118", name: "Klein Tools Wire Stripper/Cutter 10-18 AWG", brand: "Klein Tools", category: "Hand Tools", price: 2497 },
  { barcode: "0037103288417", name: "Husky 24 in Aluminum Level", brand: "Husky", category: "Hand Tools", price: 2497 },
  { barcode: "0076174905014", name: "Stanley 6 pc Screwdriver Set", brand: "Stanley", category: "Hand Tools", price: 1499 },
];

// ---- Fasteners & hardware -------------------------------------------------
const FASTENERS: SeedProduct[] = [
  { barcode: "0030699112345", name: 'Everbilt #8 x 1-1/4in Wood Screws 1lb', brand: "Everbilt", category: "Fasteners", price: 897 },
  { barcode: "0030699223456", name: 'Everbilt 3in Deck Screws 5lb', brand: "Everbilt", category: "Fasteners", price: 2497 },
  { barcode: "0030699334567", name: 'Everbilt 1/4in x 2in Hex Lag Screws 25pk', brand: "Everbilt", category: "Fasteners", price: 1097 },
  { barcode: "0741655102030", name: 'Grip-Rite 16d Bright Common Nails 5lb', brand: "Grip-Rite", category: "Fasteners", price: 1697 },
  { barcode: "0741655203040", name: 'Grip-Rite 1-1/4in Drywall Screws 5lb', brand: "Grip-Rite", category: "Fasteners", price: 1997 },
  { barcode: "0044315410203", name: "Simpson Strong-Tie Joist Hanger 2x8", brand: "Simpson Strong-Tie", category: "Fasteners", price: 289 },
  { barcode: "0044315520304", name: "Simpson Strong-Tie Angle Bracket L50", brand: "Simpson Strong-Tie", category: "Fasteners", price: 159 },
  { barcode: "0030699445678", name: "Everbilt 3/8in Zinc Washers 25pk", brand: "Everbilt", category: "Fasteners", price: 498 },
  { barcode: "0030699556789", name: "Everbilt 1/2in Hex Nuts 20pk", brand: "Everbilt", category: "Fasteners", price: 598 },
  { barcode: "0030699667890", name: "Everbilt Wall Anchors Assorted 50pk", brand: "Everbilt", category: "Fasteners", price: 799 },
];

// ---- Paint, sundries & tape ----------------------------------------------
const PAINT: SeedProduct[] = [
  { barcode: "0082901352013", name: "BEHR PREMIUM PLUS Interior Flat White 1gal", brand: "BEHR", category: "Paint", price: 3298 },
  { barcode: "0082901452014", name: "BEHR MARQUEE Interior Semi-Gloss 1gal", brand: "BEHR", category: "Paint", price: 4998 },
  { barcode: "0020066201234", name: "Rust-Oleum Painter's Touch 2X Gloss Black", brand: "Rust-Oleum", category: "Paint", price: 598 },
  { barcode: "0020066302345", name: "Rust-Oleum Professional Primer Spray Gray", brand: "Rust-Oleum", category: "Paint", price: 749 },
  { barcode: "0051652051234", name: "KILZ 2 All-Purpose Primer 1gal", brand: "KILZ", category: "Paint", price: 2298 },
  { barcode: "0076818016108", name: "FrogTape Multi-Surface Painter's Tape 1.41in", brand: "FrogTape", category: "Paint", price: 899 },
  { barcode: "0051131687660", name: "3M ScotchBlue Painter's Tape 1.88in", brand: "3M", category: "Paint", price: 799 },
  { barcode: "0071497554321", name: "Purdy 9in Roller Cover 3pk 3/8in Nap", brand: "Purdy", category: "Paint", price: 1197 },
  { barcode: "0071497665432", name: "Purdy XL 2in Angled Sash Brush", brand: "Purdy", category: "Paint", price: 1399 },
  { barcode: "0073502012345", name: "9in Metal Paint Tray with Liner", brand: "Leaktite", category: "Paint", price: 649 },
];

// ---- Electrical -----------------------------------------------------------
const ELECTRICAL: SeedProduct[] = [
  { barcode: "0078477090015", name: "Leviton 15A Duplex Receptacle White 10pk", brand: "Leviton", category: "Electrical", price: 1097 },
  { barcode: "0078477100122", name: "Leviton Decora Rocker Switch White 10pk", brand: "Leviton", category: "Electrical", price: 1497 },
  { barcode: "0032886500213", name: "Southwire 12/2 NM-B Wire 50ft", brand: "Southwire", category: "Electrical", price: 4497 },
  { barcode: "0032886600324", name: "Southwire 14/2 NM-B Wire 25ft", brand: "Southwire", category: "Electrical", price: 2197 },
  { barcode: "0032076104512", name: "Klein Tools Non-Contact Voltage Tester", brand: "Klein Tools", category: "Electrical", price: 1997 },
  { barcode: "0781087204513", name: "Ideal Wire Connectors Wing-Nut 100pk", brand: "Ideal", category: "Electrical", price: 999 },
  { barcode: "0050169805213", name: "Gardner Bender Electrical Tape Black 10pk", brand: "Gardner Bender", category: "Electrical", price: 899 },
  { barcode: "0078477880124", name: "Leviton GFCI Outlet 20A White", brand: "Leviton", category: "Electrical", price: 1897 },
  { barcode: "0783585102031", name: "Carlon 1-Gang Old Work Box", brand: "Carlon", category: "Electrical", price: 189 },
  { barcode: "0032664102034", name: "GE 15A Single Pole Circuit Breaker", brand: "GE", category: "Electrical", price: 799 },
];

// ---- Plumbing -------------------------------------------------------------
const PLUMBING: SeedProduct[] = [
  { barcode: "0648390120015", name: "SharkBite 1/2in Push-to-Connect Coupling", brand: "SharkBite", category: "Plumbing", price: 799 },
  { barcode: "0648390230126", name: "SharkBite 3/4in x 1/2in Reducing Tee", brand: "SharkBite", category: "Plumbing", price: 1299 },
  { barcode: "0039961000217", name: "Fluidmaster 400A Toilet Fill Valve", brand: "Fluidmaster", category: "Plumbing", price: 1097 },
  { barcode: "0039961200418", name: "Fluidmaster Wax Toilet Bowl Ring", brand: "Fluidmaster", category: "Plumbing", price: 549 },
  { barcode: "0038753310015", name: "Oatey PVC Cement 8oz", brand: "Oatey", category: "Plumbing", price: 799 },
  { barcode: "0038753410126", name: "Oatey Plumber's Putty 14oz", brand: "Oatey", category: "Plumbing", price: 449 },
  { barcode: "0026508101234", name: "Moen Chateau Chrome Bathroom Faucet", brand: "Moen", category: "Plumbing", price: 8900 },
  { barcode: "0012611202031", name: "BrassCraft 3/8in Compression Supply Line", brand: "BrassCraft", category: "Plumbing", price: 699 },
  { barcode: "0075040102030", name: "Teflon Thread Seal Tape 1/2in x 520in", brand: "Oatey", category: "Plumbing", price: 129 },
  { barcode: "0671048102034", name: "1/2in x 10ft PEX-B Tubing Red", brand: "Apollo", category: "Plumbing", price: 599 },
];

// ---- Adhesives, sealants & abrasives -------------------------------------
const ADHESIVES: SeedProduct[] = [
  { barcode: "0032247315012", name: "Gorilla Wood Glue 8oz", brand: "Gorilla", category: "Adhesives & Tape", price: 599 },
  { barcode: "0032247415123", name: "Gorilla Super Glue Gel 20g", brand: "Gorilla", category: "Adhesives & Tape", price: 649 },
  { barcode: "0032247515234", name: "Gorilla Tape 1.88in x 35yd Black", brand: "Gorilla", category: "Adhesives & Tape", price: 1197 },
  { barcode: "0079340007512", name: "Loctite PL Premium Construction Adhesive 10oz", brand: "Loctite", category: "Adhesives & Tape", price: 749 },
  { barcode: "0070798000123", name: "DAP Alex Plus Acrylic Latex Caulk White", brand: "DAP", category: "Adhesives & Tape", price: 349 },
  { barcode: "0077027001234", name: "GE Silicone II Window & Door Clear 10.1oz", brand: "GE", category: "Adhesives & Tape", price: 799 },
  { barcode: "0051141278018", name: "3M Sandpaper Assorted Grit 9x11 6pk", brand: "3M", category: "Abrasives", price: 799 },
  { barcode: "0051141379129", name: "3M Pro Grade Sanding Sponge Medium", brand: "3M", category: "Abrasives", price: 449 },
  { barcode: "0022078102030", name: "Command Medium Picture Hanging Strips 12pk", brand: "Command", category: "Adhesives & Tape", price: 1099 },
  { barcode: "0079340411012", name: "Loctite Threadlocker Blue 242 6ml", brand: "Loctite", category: "Adhesives & Tape", price: 899 },
];

// ---- Building materials ---------------------------------------------------
const BUILDING: SeedProduct[] = [
  { barcode: "0039645100014", name: "Quikrete Fast-Setting Concrete Mix 50lb", brand: "Quikrete", category: "Building Materials", price: 799 },
  { barcode: "0039645200125", name: "Quikrete Sand/Topping Mix 60lb", brand: "Quikrete", category: "Building Materials", price: 899 },
  { barcode: "0037813102031", name: '1/2in x 4ft x 8ft Drywall Panel', brand: "ProRoc", category: "Building Materials", price: 1598 },
  { barcode: "0733739102034", name: "USG Sheetrock Joint Compound 3.5gal", brand: "USG", category: "Building Materials", price: 1697 },
  { barcode: "0754308102037", name: "FibaTape Drywall Joint Tape 300ft", brand: "FibaTape", category: "Building Materials", price: 799 },
  { barcode: "0072691102039", name: "Owens Corning R-13 Insulation Roll", brand: "Owens Corning", category: "Building Materials", price: 5498 },
];

// ---- Safety ---------------------------------------------------------------
const SAFETY: SeedProduct[] = [
  { barcode: "0078371661015", name: "3M Safety Glasses Clear Anti-Fog", brand: "3M", category: "Safety", price: 699 },
  { barcode: "0078371772126", name: "3M N95 Sanding Respirator 10pk", brand: "3M", category: "Safety", price: 1897 },
  { barcode: "0885911447012", name: "DEWALT Leather Palm Work Gloves L", brand: "DEWALT", category: "Safety", price: 1497 },
  { barcode: "0045242990123", name: "Milwaukee Cut Level 3 Work Gloves L", brand: "Milwaukee", category: "Safety", price: 1997 },
  { barcode: "0078371883237", name: "3M Corded Ear Plugs 5pk", brand: "3M", category: "Safety", price: 599 },
  { barcode: "0717510102034", name: "MSA Hard Hat White Ratchet Suspension", brand: "MSA", category: "Safety", price: 1999 },
];

// ---- Lighting & batteries -------------------------------------------------
const LIGHTING: SeedProduct[] = [
  { barcode: "0046677540012", name: "Philips LED A19 60W Equivalent Soft White 4pk", brand: "Philips", category: "Lighting", price: 897 },
  { barcode: "0043168829014", name: "GE LED BR30 Floodlight 65W Equiv 2pk", brand: "GE", category: "Lighting", price: 998 },
  { barcode: "0017801799019", name: "Feit Electric 4ft LED Shop Light", brand: "Feit Electric", category: "Lighting", price: 2497 },
  { barcode: "0885911559012", name: "DEWALT 20V MAX LED Work Light", brand: "DEWALT", category: "Lighting", price: 5900 },
  { barcode: "0041333825014", name: "Duracell 9V Alkaline Batteries 2pk", brand: "Duracell", category: "Batteries", price: 899 },
  { barcode: "0039800112019", name: "Energizer MAX AAA Batteries 8pk", brand: "Energizer", category: "Batteries", price: 799 },
];

// ---- Lawn & garden --------------------------------------------------------
const GARDEN: SeedProduct[] = [
  { barcode: "0033287288014", name: "RYOBI ONE+ 18V String Trimmer Kit", brand: "RYOBI", category: "Outdoor & Garden", price: 12900 },
  { barcode: "0071549102034", name: "Scotts Turf Builder Lawn Fertilizer 12.5lb", brand: "Scotts", category: "Outdoor & Garden", price: 2397 },
  { barcode: "0070183102037", name: "Roundup Weed & Grass Killer 1gal", brand: "Roundup", category: "Outdoor & Garden", price: 1897 },
  { barcode: "0037103399018", name: "Husky 5 Gallon Bucket", brand: "Husky", category: "Outdoor & Garden", price: 498 },
  { barcode: "0812441102030", name: "Gilmour 50ft Heavy Duty Garden Hose", brand: "Gilmour", category: "Outdoor & Garden", price: 2999 },
  { barcode: "0086208102033", name: "Fiskars Bypass Pruner", brand: "Fiskars", category: "Outdoor & Garden", price: 1499 },
];

// ---- Storage & shop supplies ---------------------------------------------
const STORAGE: SeedProduct[] = [
  { barcode: "0045242667012", name: "Milwaukee PACKOUT Compact Tool Box", brand: "Milwaukee", category: "Storage", price: 8900 },
  { barcode: "0037103466013", name: "Husky 22 in Rolling Tool Box", brand: "Husky", category: "Storage", price: 4998 },
  { barcode: "0885911772013", name: "DEWALT TOUGHSYSTEM 2.0 Deep Toolbox", brand: "DEWALT", category: "Storage", price: 7900 },
  { barcode: "0071736102038", name: "Contractor Clean-Up Bags 42gal 20pk", brand: "HDX", category: "Shop Supplies", price: 1897 },
  { barcode: "0071736212031", name: "Blue Shop Towels 2-Roll", brand: "Scott", category: "Shop Supplies", price: 799 },
  { barcode: "0037103502034", name: "Husky 6ft Aluminum Step Ladder", brand: "Husky", category: "Ladders", price: 5900 },
  { barcode: "0049645102037", name: "Werner 6ft Fiberglass Step Ladder 300lb", brand: "Werner", category: "Ladders", price: 8900 },
];

const PRODUCTS: SeedProduct[] = [
  ...GENERAL,
  ...POWER_TOOLS,
  ...HAND_TOOLS,
  ...FASTENERS,
  ...PAINT,
  ...ELECTRICAL,
  ...PLUMBING,
  ...ADHESIVES,
  ...BUILDING,
  ...SAFETY,
  ...LIGHTING,
  ...GARDEN,
  ...STORAGE,
];

async function main() {
  // Guard against accidental duplicate barcodes in the seed data.
  const seen = new Set<string>();
  for (const p of PRODUCTS) {
    if (seen.has(p.barcode)) throw new Error(`Duplicate seed barcode: ${p.barcode} (${p.name})`);
    seen.add(p.barcode);
  }

  // Demo accounts covering all three roles so each login can be tried.
  const passwordHash = await bcrypt.hash("password123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@amreceipts.app" },
    update: { role: "admin", company: "Samaritech", title: "Administrator" },
    create: {
      email: "admin@amreceipts.app",
      name: "Ada Admin",
      passwordHash,
      role: "admin",
      company: "Samaritech",
      title: "Administrator",
    },
  });

  const approver = await prisma.user.upsert({
    where: { email: "approver@amreceipts.app" },
    update: { role: "approver", company: "Samaritech", title: "Field Supervisor" },
    create: {
      email: "approver@amreceipts.app",
      name: "Aaron Approver",
      passwordHash,
      role: "approver",
      company: "Samaritech",
      title: "Field Supervisor",
    },
  });

  // The Field Team group is overseen by the approver.
  const group = await prisma.group.upsert({
    where: { name: "Field Team" },
    update: { approverId: approver.id },
    create: { name: "Field Team", approverId: approver.id },
  });

  const user = await prisma.user.upsert({
    where: { email: "demo@amreceipts.app" },
    update: { role: "user", company: "Samaritech", title: "Field Technician", groupId: group.id },
    create: {
      email: "demo@amreceipts.app",
      name: "Demo User",
      passwordHash,
      role: "user",
      company: "Samaritech",
      title: "Field Technician",
      groupId: group.id,
    },
  });

  await prisma.job.upsert({
    where: { userId_number: { userId: user.id, number: "JOB-1001" } },
    update: {},
    create: { userId: user.id, number: "JOB-1001", name: "Downtown site fit-out" },
  });

  // The lock row for the expense-posting group. Created up front so enabling
  // an integration only ever takes a row lock, never races to insert one.
  await prisma.integrationGroup.upsert({
    where: { group: "expense_posting" },
    update: {},
    create: { group: "expense_posting", activeKey: null },
  });

  // Business-system integrations. Both start disabled and empty: they are
  // mutually exclusive (one expense-posting system at a time) and neither can
  // send anything until an admin configures it. `update: {}` so re-seeding a
  // live database never overwrites real configuration.
  await prisma.integration.upsert({
    where: { key: "psa_web" },
    update: {},
    create: {
      key: "psa_web",
      name: "PSA Web",
      enabled: false,
      config: JSON.stringify({
        baseUrl: "", companyId: "",
        defaultExpenseAccount: "", defaultCostCentre: "",
        syncExpenses: false,
      }),
    },
  });

  await prisma.integration.upsert({
    where: { key: "m3_ion" },
    update: {},
    create: {
      key: "m3_ion",
      name: "Infor M3 (ION API)",
      enabled: false,
      config: JSON.stringify({
        baseUrl: "", tokenUrl: "", clientId: "",
        authMode: "oauth_password", environment: "DEV",
        // Both safety flags in their refusing position.
        dryRun: true, armed: false, verifyTls: true,
        cono: "", divi: "", currency: "",
        suspenseAccount: "", voucherSeries: "", famFunction: "",
        maxrecs: 1000, requestTimeoutMs: 30000, connectTimeoutMs: 10000,
      }),
    },
  });

  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { barcode: p.barcode },
      update: { name: p.name, brand: p.brand, category: p.category, price: p.price },
      create: p,
    });
  }

  const byCategory = PRODUCTS.reduce<Record<string, number>>((acc, p) => {
    acc[p.category] = (acc[p.category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Seeded ${PRODUCTS.length} products across ${Object.keys(byCategory).length} categories:`);
  for (const [cat, n] of Object.entries(byCategory).sort()) console.log(`  ${cat}: ${n}`);
  console.log("Accounts (all password123):");
  console.log("  admin@amreceipts.app    (admin)");
  console.log("  approver@amreceipts.app (approver, oversees Field Team)");
  console.log("  demo@amreceipts.app     (user, member of Field Team)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
