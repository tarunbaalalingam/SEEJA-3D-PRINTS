
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32) {
  throw new Error("Set SESSION_SECRET to a random string of 32+ characters.");
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error("Set ADMIN_EMAIL and a strong ADMIN_PASSWORD in .env.");
}

const dataDir = process.env.NETLIFY === "true"
  ? path.join("/tmp", "seejas-data")
  : path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "store.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer'
      CHECK(role IN ('customer','admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Gifts',
    price_paise INTEGER NOT NULL CHECK(price_paise >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    image_url TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    PRIMARY KEY(user_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    postal_code TEXT NOT NULL,
    total_paise INTEGER NOT NULL CHECK(total_paise >= 0),
    payment_method TEXT NOT NULL DEFAULT 'COD'
      CHECK(payment_method IN ('COD')),
    status TEXT NOT NULL DEFAULT 'Pending'
      CHECK(status IN ('Pending','Confirmed','Printing','Shipped','Delivered','Cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    unit_price_paise INTEGER NOT NULL,
    quantity INTEGER NOT NULL
  );
`);

const emailKey = value => String(value || "").trim().toLowerCase();

function seedAdmin() {
  const email = emailKey(process.env.ADMIN_EMAIL);
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);

  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
    db.prepare(
      "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')"
    ).run(process.env.ADMIN_NAME || "Store Owner", email, hash);
    console.log("Initial owner account created.");
  } else {
    const user = db.prepare("SELECT role FROM users WHERE email = ?").get(email);
    if (user.role !== "admin") {
      throw new Error("Configured admin email belongs to a non-admin account.");
    }
  }
}
seedAdmin();

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);

app.use(helmet({
  // The starter uses local scripts/styles; CSP is enabled for a safer baseline.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(session({
  name: "seejas.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: dataDir
  }),
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Please log in first." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

function validText(value, max = 200) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max;
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function productView(product) {
  return {
    ...product,
    price: product.price_paise / 100,
    inStock: product.stock > 0
  };
}

function parseProduct(body) {
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const category = String(body.category || "Gifts").trim();
  const image_url = String(body.image_url || "").trim();
  const price = Number(body.price);
  const stock = Number(body.stock);

  if (!validText(name, 120)) throw new Error("Product name is required (max 120 characters).");
  if (description.length > 2000) throw new Error("Description is too long.");
  if (!["Decor", "Desk", "Gifts", "Custom"].includes(category)) {
    throw new Error("Invalid category.");
  }
  if (!Number.isFinite(price) || price < 0 || price > 1000000) {
    throw new Error("Enter a valid price.");
  }
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) {
    throw new Error("Enter a valid stock quantity.");
  }
  if (image_url && (!image_url.startsWith("/") && !/^https:\/\/[^ ]+$/i.test(image_url))) {
    throw new Error("Image must use a local path or HTTPS URL.");
  }

  return {
    name,
    description,
    category,
    image_url,
    price_paise: Math.round(price * 100),
    stock
  };
}

// Serve only browser-facing files; never expose server code, .env, or the database.
const siteDir = path.join(__dirname, "site");
app.use(express.static(siteDir, { dotfiles: "deny", index: "index.html", fallthrough: true }));
app.get("/", (req, res) => res.sendFile(path.join(siteDir, "index.html")));

// Authentication
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!validText(name, 80) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailKey(email)) ||
      typeof password !== "string" ||
      password.length < 10 || password.length > 128) {
    return res.status(400).json({
      error: "Enter a name, valid email and password of 10–128 characters."
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(`
      INSERT INTO users (name,email,password_hash,role)
      VALUES (?,?,?,'customer')
    `).run(name.trim(), emailKey(email), hash);

    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not start session." });

      req.session.user = {
        id: Number(result.lastInsertRowid),
        name: name.trim(),
        email: emailKey(email),
        role: "customer"
      };

      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: "Could not save session." });
        res.status(201).json({ user: req.session.user });
      });
    });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT")) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    console.error(error);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = emailKey(req.body?.email);
  const password = req.body?.password;

  if (!email || typeof password !== "string" || password.length > 128) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const ok = user && await bcrypt.compare(password, user.password_hash);

  if (!ok) return res.status(401).json({ error: "Invalid email or password." });

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start session." });

    req.session.user = safeUser(user);
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: "Could not save session." });
      res.json({ user: req.session.user });
    });
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/auth/logout", requireLogin, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Logout failed." });
    res.clearCookie("seejas.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax"
    });
    res.json({ ok: true });
  });
});

// Public product catalogue
app.get("/api/products", (req, res) => {
  const products = db.prepare(`
    SELECT * FROM products WHERE active = 1 ORDER BY id DESC
  `).all();
  res.json(products.map(productView));
});

app.get("/api/products/:id", (req, res) => {
  const product = db.prepare(
    "SELECT * FROM products WHERE id = ? AND active = 1"
  ).get(Number(req.params.id));

  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json(productView(product));
});

// Admin-only product management
app.get("/api/admin/products", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all().map(productView));
});

app.post("/api/admin/products", requireAdmin, (req, res) => {
  try {
    const p = parseProduct(req.body);
    const result = db.prepare(`
      INSERT INTO products (name,description,category,price_paise,stock,image_url)
      VALUES (@name,@description,@category,@price_paise,@stock,@image_url)
    `).run(p);
    res.status(201).json({
      id: Number(result.lastInsertRowid),
      message: "Product created."
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/admin/products/:id", requireAdmin, (req, res) => {
  try {
    const p = parseProduct(req.body);
    const result = db.prepare(`
      UPDATE products
      SET name=@name, description=@description, category=@category,
          price_paise=@price_paise, stock=@stock, image_url=@image_url
      WHERE id=@id
    `).run({ ...p, id: Number(req.params.id) });

    if (!result.changes) return res.status(404).json({ error: "Product not found." });
    res.json({ message: "Product updated." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const result = db.prepare(
    "UPDATE products SET active = 0 WHERE id = ?"
  ).run(Number(req.params.id));

  if (!result.changes) return res.status(404).json({ error: "Product not found." });
  res.json({ message: "Product removed from the store." });
});

// Customer cart
app.get("/api/cart", requireLogin, (req, res) => {
  const items = db.prepare(`
    SELECT p.id, p.name, p.price_paise, p.stock, p.image_url, c.quantity
    FROM cart_items c
    JOIN products p ON p.id = c.product_id
    WHERE c.user_id = ? AND p.active = 1
  `).all(req.session.user.id);

  res.json({
    items: items.map(item => ({
      ...item,
      price: item.price_paise / 100,
      lineTotal: item.price_paise * item.quantity / 100
    }))
  });
});

app.post("/api/cart/items", requireLogin, (req, res) => {
  const productId = Number(req.body?.productId);
  const quantity = Number(req.body?.quantity ?? 1);

  if (!Number.isInteger(productId) || !Number.isInteger(quantity) ||
      quantity < 1 || quantity > 50) {
    return res.status(400).json({ error: "Invalid product or quantity." });
  }

  const product = db.prepare(
    "SELECT id,stock FROM products WHERE id = ? AND active = 1"
  ).get(productId);

  if (!product) return res.status(404).json({ error: "Product not found." });

  const existing = db.prepare(
    "SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?"
  ).get(req.session.user.id, productId);

  if ((existing?.quantity || 0) + quantity > product.stock) {
    return res.status(400).json({ error: "Requested quantity exceeds current stock." });
  }

  db.prepare(`
    INSERT INTO cart_items (user_id,product_id,quantity) VALUES (?,?,?)
    ON CONFLICT(user_id,product_id)
    DO UPDATE SET quantity = quantity + excluded.quantity
  `).run(req.session.user.id, productId, quantity);

  res.json({ message: "Added to cart." });
});

app.patch("/api/cart/items/:productId", requireLogin, (req, res) => {
  const productId = Number(req.params.productId);
  const quantity = Number(req.body?.quantity);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return res.status(400).json({ error: "Quantity must be between 1 and 50." });
  }

  const product = db.prepare(
    "SELECT stock FROM products WHERE id = ? AND active = 1"
  ).get(productId);

  if (!product) return res.status(404).json({ error: "Product not found." });
  if (quantity > product.stock) {
    return res.status(400).json({ error: "Quantity exceeds available stock." });
  }

  db.prepare(`
    UPDATE cart_items SET quantity = ?
    WHERE user_id = ? AND product_id = ?
  `).run(quantity, req.session.user.id, productId);

  res.json({ message: "Cart updated." });
});

app.delete("/api/cart/items/:productId", requireLogin, (req, res) => {
  db.prepare(
    "DELETE FROM cart_items WHERE user_id = ? AND product_id = ?"
  ).run(req.session.user.id, Number(req.params.productId));

  res.json({ message: "Item removed." });
});

// Checkout: Cash on Delivery only in this starter.
// Prices and stock are checked again on the server.
app.post("/api/orders", requireLogin, (req, res) => {
  const { customerName, phone, address, city, postalCode, paymentMethod } = req.body || {};

  if (![customerName, phone, address, city, postalCode].every(v => validText(v, 200))) {
    return res.status(400).json({ error: "Complete all delivery details." });
  }
  if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) {
    return res.status(400).json({ error: "Enter a valid phone number." });
  }
  if (paymentMethod && paymentMethod !== "COD") {
    return res.status(400).json({ error: "Online payment is not enabled yet." });
  }

  const checkout = db.transaction(() => {
    const userId = req.session.user.id;
    const cart = db.prepare(`
      SELECT p.id, p.name, p.price_paise, p.stock, c.quantity
      FROM cart_items c JOIN products p ON p.id = c.product_id
      WHERE c.user_id = ? AND p.active = 1
    `).all(userId);

    if (!cart.length) throw new Error("Your cart is empty.");

    for (const item of cart) {
      if (item.quantity > item.stock) {
        throw new Error(`Insufficient stock for ${item.name}. Please update your cart.`);
      }
    }

    const total = cart.reduce(
      (sum, item) => sum + item.price_paise * item.quantity, 0
    );

    const order = db.prepare(`
      INSERT INTO orders
      (user_id,customer_name,phone,address,city,postal_code,total_paise,payment_method)
      VALUES (?,?,?,?,?,?,?,'COD')
    `).run(
      userId, customerName.trim(), phone.trim(), address.trim(),
      city.trim(), postalCode.trim(), total
    );

    const orderId = Number(order.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id,product_id,product_name,unit_price_paise,quantity)
      VALUES (?,?,?,?,?)
    `);
    const reduceStock = db.prepare(
      "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
    );

    for (const item of cart) {
      insertItem.run(orderId, item.id, item.name, item.price_paise, item.quantity);
      const update = reduceStock.run(item.quantity, item.id, item.quantity);
      if (!update.changes) throw new Error("Stock changed. Please try checkout again.");
    }

    db.prepare("DELETE FROM cart_items WHERE user_id = ?").run(userId);
    return { orderId, total };
  });

  try {
    const result = checkout();
    res.status(201).json({
      message: "Order placed successfully.",
      orderId: result.orderId,
      total: result.total / 100,
      paymentMethod: "COD"
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Checkout failed." });
  }
});

// Customer sees only their own orders; admin can see all orders.
app.get("/api/orders", requireLogin, (req, res) => {
  const isAdmin = req.session.user.role === "admin";
  const orders = isAdmin
    ? db.prepare(`
        SELECT o.*, u.email AS customer_email FROM orders o
        JOIN users u ON u.id = o.user_id ORDER BY o.id DESC
      `).all()
    : db.prepare(
        "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC"
      ).all(req.session.user.id);

  const itemQuery = db.prepare("SELECT * FROM order_items WHERE order_id = ?");
  res.json(orders.map(order => ({
    ...order,
    total: order.total_paise / 100,
    items: itemQuery.all(order.id).map(item => ({
      ...item,
      unitPrice: item.unit_price_paise / 100
    }))
  })));
});

app.patch("/api/admin/orders/:id/status", requireAdmin, (req, res) => {
  const allowed = ["Pending", "Confirmed", "Printing", "Shipped", "Delivered", "Cancelled"];
  const status = req.body?.status;

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid order status." });
  }

  const result = db.prepare("UPDATE orders SET status = ? WHERE id = ?")
    .run(status, Number(req.params.id));

  if (!result.changes) return res.status(404).json({ error: "Order not found." });
  res.json({ message: "Order status updated." });
});

// Helpful API error response
app.use("/api", (err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

if (process.env.NETLIFY !== "true") {
  app.listen(PORT, () => {
    console.log(`Seejas 3D Prints running at http://localhost:${PORT}`);
  });
}

module.exports = app;
