/**
 * Self-contained responsive fixture: a top nav that collapses to a hamburger
 * at ≤768px. On mobile the inline links are display:none (so they leave the
 * accessibility tree entirely) and the toggle button appears.
 */

export const RESPONSIVE_NAV_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lattice Responsive Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; }
    .brand { font-weight: 700; font-size: 18px; }
    .nav-links { display: flex; gap: 16px; list-style: none; }
    .nav-links a { text-decoration: none; color: #1a1a1a; }
    .hamburger { display: none; font-size: 20px; background: none; border: 1px solid #ccc; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
    main { padding: 24px 16px; }
    @media (max-width: 768px) {
      .nav-links { display: none; }
      .hamburger { display: inline-flex; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">Lattice</div>
    <nav aria-label="Main">
      <ul class="nav-links">
        <li><a href="/home">Home</a></li>
        <li><a href="/products">Products</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/about">About</a></li>
      </ul>
      <button class="hamburger" type="button" aria-label="Open menu" aria-expanded="false">☰</button>
    </nav>
  </header>
  <main>
    <h1>Welcome to Lattice</h1>
    <p>Responsive navigation demo for the mobile sanity check.</p>
  </main>
</body>
</html>`;
