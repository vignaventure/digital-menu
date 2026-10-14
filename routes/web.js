// Page routes. The dashboards are static pages that talk to /api/v1; only the landing page is server-rendered.
const router = require('express').Router();
const path = require('path');
const svc = require('../lib/service');

const file = name => path.join(__dirname, '..', 'public', name);

router.get('/', (req, res) => res.render('landing', { contact: process.env.CONTACT_EMAIL || '' }));
router.get('/login', (req, res) => res.sendFile(file('login.html')));
router.get('/admin', (req, res) => res.sendFile(file('admin.html')));
router.get('/api/docs', (req, res) => res.sendFile(file('api-docs.html')));
router.get('/dashboard', (req, res) => res.sendFile(file('dashboard.html')));
// The menu page loads its data from the API; a missing/inactive/expired menu gets a real 404 status.
router.get('/m/:slug', async (req, res) => res.status(await svc.getMenu(req.params.slug) ? 200 : 404).sendFile(file('menu.html')));

module.exports = router;
