// OpenAPI 3 description of /api/v1, served at /api/v1/openapi.json and shown at /api/docs.
// tests/openapi.test.js checks that every operation listed here is a real route, so keep the two in step.
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ content: { 'application/json': { schema } } });
const err = description => ({ description, ...json(ref('Error')) });

const responses = {
  400: err('Invalid input'), 401: err('Not logged in, or the login expired'), 403: err('Not allowed for this role'),
  404: err('Not found'), 409: err('Conflict (value already in use / still referenced)'),
};
const pick = (...codes) => Object.fromEntries(codes.map(c => [c, responses[c]]));
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const none = { 204: { description: 'Done, no content' } };

const BOTH = [{ bearerAuth: [] }, { cookieAuth: [] }];
const op = (tag, summary, { description, auth = true, params, body, ok = { 200: { description: 'OK' } }, errors = [401] } = {}) => ({
  tags: [tag], summary, ...(description && { description }),
  ...(auth ? { security: BOTH } : { security: [] }),
  ...(params && { parameters: params }),
  ...(body && { requestBody: { required: true, content: body } }),
  responses: { ...ok, ...pick(...errors) },
});
const jsonBody = schema => ({ 'application/json': { schema } });
const okJson = (schema, code = 200, description = 'OK') => ({ [code]: { description, ...json(schema) } });

const itemProps = {
  name: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 300 },
  price: { type: 'number', minimum: 0, description: 'Rupees, e.g. 199.5' }, category_id: { type: 'integer' },
  available: { type: 'boolean', description: 'false hides the item from guests' },
  remove_image: { type: 'boolean', description: 'PUT only: clear the current photo' },
};
const itemJson = {
  type: 'object', required: ['name', 'price', 'category_id'],
  properties: { ...itemProps, image: { type: 'string', description: 'PNG/JPEG/WebP data URL (about 1.5 MB max)', example: 'data:image/jpeg;base64,/9j/4AAQ…' } },
};
const itemMultipart = {
  type: 'object', required: ['name', 'price', 'category_id'],
  properties: { name: itemProps.name, description: itemProps.description, price: itemProps.price, category_id: itemProps.category_id, available: itemProps.available, image: { type: 'string', format: 'binary', description: 'jpeg/png/webp/gif, 5 MB max' } },
};
const itemBody = { 'application/json': { schema: itemJson }, 'multipart/form-data': { schema: itemMultipart } };

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Digital Menu API',
    version: '1.0.0',
    description: [
      'The API behind the admin console, the restaurant dashboard and the guest menu. Everything those screens do, you can do here.',
      '',
      '**Logging in.** Call `POST /auth/login` with an email *or mobile number* and password, then click **Authorize** and paste the token (valid 12 hours). Browsers use `POST /auth/session` instead, which sets a login cookie; if you are already logged in to the dashboard in this browser, "Try it out" works without a token.',
      '',
      '**Roles.** `admin` manages restaurants. `owner` manages one restaurant\'s menu. The guest menu needs no login.',
      '',
      'Errors are always `{"error": "message"}`. Login attempts are rate limited.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Public', description: 'Guest menu, no login' }, { name: 'Auth' },
    { name: 'Admin', description: 'Super admin only: onboard and manage restaurants, and manage any restaurant\'s menu on its behalf' },
    { name: 'Restaurant', description: 'Restaurant owner only: profile, categories, menu items, QR' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token from POST /auth/login' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sid', description: 'Set by POST /auth/session (used by the dashboards)' },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
      User: {
        type: 'object', properties: {
          id: { type: 'integer' }, email: { type: 'string', nullable: true }, mobile: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['admin', 'owner'] }, restaurant_id: { type: 'integer', nullable: true },
        },
      },
      Login: {
        type: 'object', required: ['identifier', 'password'],
        properties: { identifier: { type: 'string', description: 'Email address or mobile number', example: '9876543210' }, password: { type: 'string' } },
      },
      PasswordChange: {
        type: 'object', required: ['current_password', 'new_password'],
        properties: { current_password: { type: 'string' }, new_password: { type: 'string', minLength: 6 } },
      },
      Restaurant: {
        type: 'object', properties: {
          id: { type: 'integer' }, name: { type: 'string' }, slug: { type: 'string' }, active: { type: 'boolean', description: 'false = deactivated: menu hidden, owner locked out' },
          owner: { type: 'string' }, city: { type: 'string' }, address: { type: 'string' }, tagline: { type: 'string' },
          theme_color: { type: 'string', example: '#d9480f' }, logo: { type: 'string', nullable: true, description: 'Path such as /uploads/….jpg' },
          contact_phone: { type: 'string', description: 'Phone shown on the guest menu' },
          price_paid: { type: 'number', description: 'Onboarding price in rupees' }, paid: { type: 'boolean', description: 'Onboarding payment received' },
          plan_type: { type: 'string', enum: ['one_time', 'limited'] }, plan_expires: { type: 'string', format: 'date', nullable: true },
          created_at: { type: 'string' }, owner_email: { type: 'string', nullable: true }, owner_mobile: { type: 'string', nullable: true },
          has_password: { type: 'boolean', description: 'Admin list only: whether the password can be viewed' },
          generated_password: { type: 'string', description: 'Only in the response that created the restaurant, and only if the password was generated' },
          menu_url: { type: 'string' }, item_count: { type: 'integer', description: 'Admin list only' },
        },
      },
      RestaurantCreate: {
        type: 'object', required: ['name', 'mobile'], properties: {
          name: { type: 'string' }, owner: { type: 'string', description: "Owner's name" },
          mobile: { type: 'string', description: "Required. The owner's login. 7-15 digits, optional +; spaces and dashes are ignored.", example: '9876543210' },
          email: { type: 'string', description: 'Optional second way to log in' }, city: { type: 'string' },
          price_paid: { type: 'number', description: 'Onboarding price in rupees', default: 0 }, paid: { type: 'boolean', default: false },
          password: { type: 'string', minLength: 6, description: 'Leave out to have one generated (returned once as generated_password)' },
          plan_type: { type: 'string', enum: ['one_time', 'limited'], default: 'one_time' },
          plan_expires: { type: 'string', format: 'date', description: 'Required when plan_type is limited' },
        },
      },
      RestaurantUpdate: {
        type: 'object', description: 'Send only what changes', properties: {
          name: { type: 'string' }, owner: { type: 'string' }, city: { type: 'string' }, active: { type: 'boolean' },
          price_paid: { type: 'number' }, paid: { type: 'boolean' }, plan_type: { type: 'string', enum: ['one_time', 'limited'] },
          plan_expires: { type: 'string', format: 'date', nullable: true }, mobile: { type: 'string' }, email: { type: 'string', nullable: true },
          password: { type: 'string', minLength: 6, description: "Sets a new login password" },
        },
      },
      Summary: {
        type: 'object', properties: {
          restaurants: { type: 'integer' }, active: { type: 'integer' }, inactive: { type: 'integer' },
          revenue: { type: 'number', description: 'Sum of onboarding prices marked paid' }, outstanding: { type: 'number', description: 'Sum of onboarding prices not yet paid' },
        },
      },
      Credentials: { type: 'object', properties: { mobile: { type: 'string' }, email: { type: 'string', nullable: true }, password: { type: 'string' } } },
      ProfileUpdate: {
        type: 'object', required: ['name'], properties: {
          name: { type: 'string', maxLength: 80 }, owner: { type: 'string' }, contact_phone: { type: 'string', maxLength: 20 }, city: { type: 'string' },
          address: { type: 'string', maxLength: 400 }, tagline: { type: 'string', maxLength: 120 },
          theme_color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', example: '#c2410c' },
          logo: { type: 'string', description: 'PNG/JPEG/WebP data URL' }, remove_logo: { type: 'boolean' },
        },
      },
      Category: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, sort: { type: 'integer' }, items: { type: 'integer', description: 'Number of items in it' } } },
      CategoryName: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 40 } } },
      Item: {
        type: 'object', properties: {
          id: { type: 'integer' }, category_id: { type: 'integer' }, category: { type: 'string', description: 'Category name (item lists only)' },
          name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number', description: 'Rupees' }, available: { type: 'boolean' },
          image: { type: 'string', nullable: true, description: 'Path such as /uploads/….jpg' }, image_url: { type: 'string', nullable: true, description: 'Absolute URL of the photo' },
        },
      },
      PublicMenu: {
        type: 'object', properties: {
          restaurant: {
            type: 'object', properties: {
              name: { type: 'string' }, slug: { type: 'string' }, tagline: { type: 'string' }, theme_color: { type: 'string' },
              logo: { type: 'string', nullable: true }, city: { type: 'string' }, address: { type: 'string' }, phone: { type: 'string' },
            },
          },
          categories: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, items: { type: 'array', items: ref('Item') } } } },
        },
      },
    },
  },
  paths: {
    '/public/menu/{slug}': {
      get: op('Public', 'Guest menu', {
        auth: false, description: 'What a guest sees after scanning the QR code: branding plus categories with their available items. 404 if the restaurant is inactive or its plan has expired.',
        params: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'spice-garden' }], ok: okJson(ref('PublicMenu')), errors: [404],
      }),
    },

    '/auth/login': {
      post: op('Auth', 'Log in, get a token', {
        auth: false, description: 'For API clients. Use the token as `Authorization: Bearer <token>`.', body: jsonBody(ref('Login')),
        ok: okJson({ type: 'object', properties: { token: { type: 'string' }, expires_in: { type: 'integer', example: 43200 }, user: ref('User') } }),
        errors: [401, 403],
      }),
    },
    '/auth/session': {
      post: op('Auth', 'Log in, get a cookie', {
        auth: false, description: 'For browsers: sets an HTTP-only cookie. Writes sent with the cookie must come from the same site.', body: jsonBody(ref('Login')),
        ok: okJson({ type: 'object', properties: { role: { type: 'string', enum: ['admin', 'owner'] }, user: ref('User') } }), errors: [401, 403],
      }),
      delete: op('Auth', 'Log out (cookie)', { auth: false, ok: none, errors: [] }),
    },
    '/auth/me': { get: op('Auth', 'Who am I', { ok: okJson({ type: 'object', properties: { user: ref('User') } }) }) },
    '/auth/password': {
      post: op('Auth', 'Change my password', {
        description: 'If an owner changes their own password, the copy the admin could view is cleared.', body: jsonBody(ref('PasswordChange')), ok: none, errors: [400, 401],
      }),
    },

    '/admin/summary': { get: op('Admin', 'Dashboard numbers', { ok: okJson(ref('Summary')), errors: [401, 403] }) },
    '/admin/restaurants': {
      get: op('Admin', 'List restaurants', { ok: okJson({ type: 'object', properties: { restaurants: { type: 'array', items: ref('Restaurant') } } }), errors: [401, 403] }),
      post: op('Admin', 'Onboard a restaurant', {
        description: 'Creates the restaurant and the owner login in one step. A blank password is generated and returned once.',
        body: jsonBody(ref('RestaurantCreate')), ok: okJson(ref('Restaurant'), 201, 'Created'), errors: [400, 401, 403, 409],
      }),
    },
    '/admin/restaurants/{id}': {
      get: op('Admin', 'Get a restaurant', { params: [idParam], ok: okJson(ref('Restaurant')), errors: [401, 403, 404] }),
      patch: op('Admin', 'Edit a restaurant', {
        description: '`active: false` deactivates it at once: the menu disappears and the owner is signed out.',
        params: [idParam], body: jsonBody(ref('RestaurantUpdate')), ok: okJson(ref('Restaurant')), errors: [400, 401, 403, 404, 409],
      }),
      delete: op('Admin', 'Delete a restaurant', { description: 'Removes the restaurant, its login, items and photos.', params: [idParam], ok: none, errors: [401, 403, 404] }),
    },
    '/admin/restaurants/{id}/reset-password': {
      post: op('Admin', 'Generate a new owner password', { description: 'The old password stops working. The new one is returned here.', params: [idParam], ok: okJson(ref('Credentials')), errors: [401, 403, 404] }),
    },
    '/admin/restaurants/{id}/password': {
      post: op('Admin', 'Set a specific owner password', {
        params: [idParam], body: jsonBody({ type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 6 } } }), ok: none, errors: [400, 401, 403, 404],
      }),
    },
    '/admin/restaurants/{id}/reveal-password': {
      post: op('Admin', 'View the owner password', {
        description: 'Returns the password the admin set, or `null` if the owner has since chosen their own. Stored encrypted; never cached.',
        params: [idParam], ok: okJson({ type: 'object', properties: { password: { type: 'string', nullable: true } } }), errors: [401, 403, 404],
      }),
    },

    '/restaurant': {
      get: op('Restaurant', 'My restaurant', { ok: okJson(ref('Restaurant')), errors: [401, 403] }),
      patch: op('Restaurant', 'Update branding and business info', {
        description: 'Login mobile and email are changed by the admin only.', body: jsonBody(ref('ProfileUpdate')), ok: okJson(ref('Restaurant')), errors: [400, 401, 403],
      }),
    },
    '/categories': {
      get: op('Restaurant', 'List categories', { ok: okJson({ type: 'object', properties: { categories: { type: 'array', items: ref('Category') } } }), errors: [401, 403] }),
      post: op('Restaurant', 'Add a category', { body: jsonBody(ref('CategoryName')), ok: okJson(ref('Category'), 201, 'Created'), errors: [400, 401, 403] }),
    },
    '/categories/{id}': {
      put: op('Restaurant', 'Rename a category', { params: [idParam], body: jsonBody(ref('CategoryName')), ok: okJson(ref('Category')), errors: [400, 401, 403, 404] }),
      delete: op('Restaurant', 'Delete a category', { description: 'Refused with 409 while the category still has items.', params: [idParam], ok: none, errors: [401, 403, 404, 409] }),
    },
    '/items': {
      get: op('Restaurant', 'List menu items', {
        params: [{ name: 'category_id', in: 'query', schema: { type: 'integer' } }],
        ok: okJson({ type: 'object', properties: { items: { type: 'array', items: ref('Item') } } }), errors: [401, 403],
      }),
      post: op('Restaurant', 'Add a menu item', {
        description: 'Send JSON (photo as a data URL) or multipart/form-data (photo as a file).', body: itemBody, ok: okJson(ref('Item'), 201, 'Created'), errors: [400, 401, 403],
      }),
    },
    '/items/{id}': {
      get: op('Restaurant', 'Get a menu item', { params: [idParam], ok: okJson(ref('Item')), errors: [401, 403, 404] }),
      put: op('Restaurant', 'Edit a menu item', {
        description: 'Leave out `image` to keep the current photo; send `remove_image: true` to clear it.', params: [idParam], body: itemBody, ok: okJson(ref('Item')), errors: [400, 401, 403, 404],
      }),
      delete: op('Restaurant', 'Delete a menu item', { params: [idParam], ok: none, errors: [401, 403, 404] }),
    },
    '/items/{id}/availability': {
      patch: op('Restaurant', 'Show or hide an item', {
        description: 'Leave `available` out to toggle.', params: [idParam],
        body: jsonBody({ type: 'object', properties: { available: { type: 'boolean' } } }), ok: okJson(ref('Item')), errors: [401, 403, 404],
      }),
    },
    '/library/categories': {
      get: op('Restaurant', 'Categories other restaurants publish', {
        description: 'The "Add menu" catalogue. Only what guests can already see: categories with at least one shown dish, from active restaurants. Your own restaurant is left out.',
        ok: okJson({ type: 'object', properties: { categories: { type: 'array', items: { type: 'object', properties: {
          category_id: { type: 'integer' }, name: { type: 'string' }, restaurant_id: { type: 'integer' }, restaurant: { type: 'string' }, items: { type: 'integer' } } } } } }), errors: [401, 403],
      }),
    },
    '/library/items': {
      get: op('Restaurant', 'Search dishes other restaurants publish', {
        params: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Matches name or description' },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Category name (case-insensitive)' },
          { name: 'restaurant_id', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 40 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        ok: okJson({ type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'integer' }, name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, image: { type: 'string', nullable: true },
          category: { type: 'string' }, restaurant_id: { type: 'integer' }, restaurant: { type: 'string' } } } } } }), errors: [401, 403],
      }),
    },
    '/library/import': {
      post: op('Restaurant', 'Copy dishes and categories into my menu', {
        description: 'Categories are matched by name (created if missing), dishes already in the same category are skipped, photos are copied. At most 300 dishes per call.',
        body: jsonBody({ type: 'object', properties: {
          items: { type: 'array', items: { type: 'integer' }, description: 'Dish ids from /library/items' },
          categories: { type: 'array', items: { type: 'object', required: ['category_id'], properties: { category_id: { type: 'integer' }, with_items: { type: 'boolean', description: 'Also copy every shown dish in that category' } } } },
        } }),
        ok: okJson({ type: 'object', properties: { added_items: { type: 'integer' }, skipped_items: { type: 'integer' }, added_categories: { type: 'integer' } } }), errors: [400, 401, 403],
      }),
    },
    '/qr.png': {
      get: op('Restaurant', 'QR code for the menu', {
        params: [
          { name: 'size', in: 'query', schema: { type: 'integer', minimum: 128, maximum: 2048, default: 800 }, description: 'Width in pixels' },
          { name: 'download', in: 'query', schema: { type: 'integer', enum: [1] }, description: 'Send as a file download' },
          { name: 'level', in: 'query', schema: { type: 'string', enum: ['L', 'M', 'Q', 'H'], default: 'M' }, description: 'Error correction. Use H when placing a logo in the middle of the code.' },
        ],
        ok: { 200: { description: 'PNG image', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } } }, errors: [401, 403],
      }),
    },
  },
};

// The admin can run the same category/item operations for any restaurant: /admin/restaurants/{id}/categories, /items, ...
const refParam = { name: 'ref', in: 'path', required: true, schema: { type: 'integer' }, description: 'Category or item id' };
const restaurantParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Restaurant id' };
for (const [p, ops] of Object.entries({ ...spec.paths })) {
  if (!/^\/(categories|items|library)/.test(p)) continue;
  spec.paths['/admin/restaurants/{id}' + p.replace('{id}', '{ref}')] = Object.fromEntries(Object.entries(ops).map(([method, o]) => [method, {
    ...o, tags: ['Admin'], summary: `${o.summary} (admin, for a restaurant)`,
    parameters: [restaurantParam, ...(o.parameters || []).filter(x => x.name !== 'id'), ...(p.includes('{id}') ? [refParam] : [])],
    responses: { ...o.responses, ...pick(404) },
  }]));
}

module.exports = spec;
