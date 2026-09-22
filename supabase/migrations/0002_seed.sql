-- Seed accounts and starter categorization rules. Safe to re-run.
--
-- Needs a user to own the rows. Any of these work:
--
--   select public.seed_defaults();                     -- exactly one user exists,
--                                                      -- or you are signed in
--   select public.seed_defaults('<user-uuid>');        -- pick one explicitly
--
-- To create that user before the app exists:
--   Dashboard -> Authentication -> Users -> Add user (email + password).
-- Its UUID is shown in that list.

create unique index if not exists accounts_label_uq on public.accounts (user_id, label);
create unique index if not exists rules_pattern_uq  on public.rules    (user_id, pattern);

-- Drop any earlier signature first. `create or replace` with a different
-- parameter list creates an OVERLOAD rather than replacing, which makes a
-- bare seed_defaults() call ambiguous.
drop function if exists public.seed_defaults();
drop function if exists public.seed_defaults(uuid);

create or replace function public.seed_defaults(p_user_id uuid default null)
returns text
language plpgsql
security invoker
as $$
declare
  uid uuid;
  n_users int;
  n_acc int;
  n_rul int;
begin
  -- Resolve the owner: explicit argument, then the signed-in user (null in the
  -- SQL Editor, which runs unauthenticated), then the only user if there is one.
  uid := coalesce(p_user_id, auth.uid());

  if uid is null then
    select count(*) into n_users from auth.users;
    if n_users = 1 then
      select id into uid from auth.users;
    elsif n_users = 0 then
      raise exception
        'No users yet. Create one under Authentication -> Users, then re-run.';
    else
      raise exception
        '% users exist. Pass one: select public.seed_defaults(''<user-uuid>'');', n_users;
    end if;
  end if;

  if not exists (select 1 from auth.users where id = uid) then
    raise exception 'No such user: %', uid;
  end if;

  -- ------------------------------------------------------------- accounts
  insert into public.accounts
    (user_id, label, type, issuer, institution, brand, last4, default_currency, scope, sort_order)
  values
    (uid, 'BAC VISA',        'card', 'bac',        'BAC Credomatic', 'visa', '4477', 'CRC', 'personal', 10),
    (uid, 'BAC AMEX',        'card', 'bac',        'BAC Credomatic', 'amex', '9654', 'CRC', 'personal', 20),
    (uid, 'Davivienda VISA', 'card', 'davivienda', 'Davivienda',     'visa', '5131', 'CRC', 'personal', 30),
    (uid, 'Promerica',       'card', 'promerica',  'Banco Promerica', null,  '1763', 'CRC', 'personal', 40),
    (uid, 'BNCR VISA (work)','card', 'bncr',       'Banco Nacional', 'visa', '0828', 'CRC', 'work',     50),
    (uid, 'Efectivo',        'cash',  null,         null,             null,   null,  'CRC', 'personal', 60),
    (uid, 'Ahorros CRC',     'savings', null,      'Davivienda',      null,   null,  'CRC', 'personal', 70),
    (uid, 'Ahorros USD',     'savings', null,      'Davivienda',      null,   null,  'USD', 'personal', 80)
  on conflict (user_id, label) do nothing;

  get diagnostics n_acc = row_count;

  -- ---------------------------------------------------------------- rules
  -- priority: lower wins. Work overrides sit at the top.
  insert into public.rules
    (user_id, pattern, match_type, priority, cat, scope, merchant_clean)
  values
    -- Vecevet tooling charged to a personal card
    (uid, 'FLUTTERFLOW',        'contains', 10, null,     'work', 'FlutterFlow'),
    (uid, 'ZEO ROUTE PLANNER',  'contains', 10, null,     'work', 'Zeo Route Planner'),
    (uid, 'Adobe',              'contains', 10, null,     'work', 'Adobe'),

    -- needs
    (uid, 'AUTO MERCADO',       'contains', 50, 'needs',  null, 'Auto Mercado'),
    (uid, 'FRESH MARKET',       'contains', 50, 'needs',  null, 'Fresh Market'),
    (uid, 'PRICESMART',         'contains', 50, 'needs',  null, 'PriceSmart'),
    (uid, 'DELTA PIRRO',        'contains', 50, 'needs',  null, 'Delta'),
    (uid, 'CYBER FUEL',         'contains', 50, 'needs',  null, 'Cyber Fuel'),
    (uid, 'GLOBAL VIA RUTA 27', 'contains', 50, 'needs',  null, 'Ruta 27'),
    (uid, 'FARMACIAS CV',       'contains', 50, 'needs',  null, 'Farmacia CV'),
    (uid, 'MEDISMART',          'contains', 50, 'needs',  null, 'Medismart'),
    (uid, 'FISCHEL',            'contains', 50, 'needs',  null, 'Fischel'),
    (uid, 'Telefonia ICE',      'contains', 50, 'needs',  null, 'ICE'),
    -- its own budget line; set budget_line_id once the line exists
    (uid, 'TERADYNE',           'contains', 40, 'needs',  null, 'Teradyne cafeteria'),

    -- wants
    (uid, 'UBER EATS',          'contains', 50, 'wants',  null, 'Uber Eats'),
    (uid, 'PedidosYa',          'contains', 50, 'wants',  null, 'PedidosYa'),
    (uid, 'UBER BV',            'contains', 50, 'wants',  null, 'Uber'),
    (uid, 'STARBUCKS',          'contains', 50, 'wants',  null, 'Starbucks'),
    (uid, 'DUNKIN',             'contains', 50, 'wants',  null, 'Dunkin'),
    (uid, 'SUBWAY',             'contains', 50, 'wants',  null, 'Subway'),
    (uid, 'MC DONALDS',         'contains', 50, 'wants',  null, 'McDonalds'),
    (uid, 'BK HEREDIA',         'contains', 50, 'wants',  null, 'Burger King'),
    (uid, 'PIZZA HUB',          'contains', 50, 'wants',  null, 'Pizza Hub'),
    (uid, 'BURGER SHOP',        'contains', 50, 'wants',  null, 'Burger Shop'),
    (uid, 'RESTAURANTE HIKARI', 'contains', 50, 'wants',  null, 'Hikari'),
    (uid, 'DUPLA',              'contains', 50, 'wants',  null, 'Dupla'),
    (uid, 'PANAVIEJA',          'contains', 50, 'wants',  null, 'Panavieja'),
    (uid, 'MUSMANNI',           'contains', 50, 'wants',  null, 'Musmanni'),
    (uid, 'ART PADEL',          'contains', 50, 'wants',  null, 'Art Padel'),
    (uid, 'LAS CANCHAS',        'contains', 50, 'wants',  null, 'Las Canchas'),
    (uid, 'Mas Padel',          'contains', 50, 'wants',  null, 'Mas Padel'),
    (uid, 'PLAYTOMIC',          'contains', 50, 'wants',  null, 'Playtomic'),
    (uid, 'MICROSOFT',          'contains', 50, 'wants',  null, 'Microsoft'),
    (uid, 'VIACOMCBS',          'contains', 50, 'wants',  null, 'Paramount+'),
    (uid, 'calimoto',           'contains', 50, 'wants',  null, 'Calimoto'),
    (uid, 'KIOSKO SAMSUNG',     'contains', 50, 'wants',  null, 'Samsung'),
    (uid, 'THULE DE CENTROAM',  'contains', 50, 'wants',  null, 'Thule')
  on conflict (user_id, pattern) do nothing;

  get diagnostics n_rul = row_count;

  -- --------------------------------------------------------------- settings
  insert into public.settings (user_id) values (uid)
  on conflict (user_id) do nothing;

  return format('seeded %s accounts, %s rules for user %s', n_acc, n_rul, uid);
end $$;
