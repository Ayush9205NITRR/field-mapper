/**
 * Field Mapper UI.
 *
 * One screen, one step at a time. Each step collapses to a one-line summary
 * once it is answered, so only the question you are currently answering is
 * ever on screen. Nothing is written until you press Run, and Preview shows
 * the exact per-record changes first.
 */

const state = {
  workflow: null,
  step: 0,
  config: null,
  // source
  csv: null, // { columns, rows, rowCount, sample }
  sourceKey: '',
  source: { baseId: '', table: '', view: '' },
  sourceFields: [],
  // destination
  destination: { baseId: '', table: '', view: '', entity: 'contact' },
  destinationFields: [],
  destinationKey: '',
  destinationKeyIsCustom: false,
  // mapping
  mappings: [],
  // options
  options: { typecast: false, separator: ', ', limit: 0 },
  credentials: { airtableToken: '', kylasApiKey: '', kylasBaseUrl: '' },
  // results
  report: null,
  busy: false,
  error: '',
};

const flowEl = document.getElementById('flow');
const pickerEl = document.getElementById('picker-section');

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const preview = (value) => {
  if (value === null || value === undefined || value === '') return '(empty)';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...state.credentials }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/* ------------------------------------------------------------ bootstrap - */

async function boot() {
  const response = await fetch('/api/config');
  state.config = await response.json();

  for (const button of pickerEl.querySelectorAll('button[data-workflow]')) {
    button.addEventListener('click', () => {
      state.workflow = button.dataset.workflow;
      state.step = 0;
      flowEl.hidden = false;
      pickerEl.hidden = true;
      render();
    });
  }
}

/* ------------------------------------------------------------ rendering - */

const WORKFLOW_TITLES = {
  'csv-to-airtable': 'CSV → Airtable',
  'airtable-to-kylas': 'Airtable → Kylas',
};

function steps() {
  return state.workflow === 'csv-to-airtable'
    ? [stepCsvSource(), stepAirtableDestination(), stepKeyMatch(), stepMapping(), stepRun()]
    : [stepAirtableSource(), stepKylasDestination(), stepKeyMatch(), stepMapping(), stepRun()];
}

function render() {
  const list = steps();
  const parts = [
    `<div class="actions" style="margin:0 0 16px">
       <button type="button" class="ghost" data-action="restart">← ${esc(
         WORKFLOW_TITLES[state.workflow]
       )} · start over</button>
     </div>`,
  ];

  list.forEach((step, index) => {
    const isActive = index === state.step;
    const isDone = index < state.step;
    const locked = index > state.step;
    const classes = ['step', isActive && 'active', isDone && 'done', locked && 'locked']
      .filter(Boolean)
      .join(' ');

    parts.push(`
      <div class="${classes}" data-step="${index}">
        <div class="step-head" data-goto="${index}">
          <span class="num">${isDone ? '✓' : index + 1}</span>
          <h2>${esc(step.title)}</h2>
          <span class="summary">${isDone ? esc(step.summary()) : ''}</span>
        </div>
        <div class="step-body">${isActive ? step.body() : ''}</div>
      </div>
    `);
  });

  flowEl.innerHTML = parts.join('');

  const active = list[state.step];
  const body = flowEl.querySelector('.step.active .step-body');
  if (active?.mount && body) active.mount(body);

  flowEl.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
    Object.assign(state, {
      workflow: null,
      step: 0,
      csv: null,
      sourceKey: '',
      sourceFields: [],
      destinationFields: [],
      destinationKey: '',
      mappings: [],
      report: null,
      error: '',
    });
    flowEl.hidden = true;
    pickerEl.hidden = false;
  });

  for (const head of flowEl.querySelectorAll('.step-head[data-goto]')) {
    head.addEventListener('click', () => {
      const target = Number(head.dataset.goto);
      if (target < state.step) {
        state.step = target;
        state.report = null;
        render();
      }
    });
  }
}

/** Advance to the next step. */
function next() {
  state.error = '';
  state.step++;
  render();
}

/** Standard footer with a Continue button. */
function footer(label = 'Continue', { disabled = false, action = 'next' } = {}) {
  return `<div class="actions">
    <div class="spacer"></div>
    <button type="button" class="primary" data-action="${action}" ${disabled ? 'disabled' : ''}>${esc(
    label
  )}</button>
  </div>`;
}

function errorNote() {
  return state.error ? `<div class="note err">${esc(state.error)}</div>` : '';
}

/** Wire a Continue button to a validator + handler. */
function wireNext(root, handler) {
  const button = root.querySelector('[data-action="next"]');
  if (!button) return;
  button.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    const original = button.textContent;
    button.innerHTML = '<span class="spin"></span>';
    try {
      state.error = '';
      // A handler returning false means "stay here and re-render" — used by
      // steps that load remote data before they can be answered.
      const advance = await handler();
      state.busy = false;
      if (advance === false) render();
      else next();
    } catch (error) {
      state.busy = false;
      state.error = error.message;
      button.disabled = false;
      button.textContent = original;
      render();
    }
  });
}

/** Credential inputs, shown only for keys the server does not already have. */
function credentialFields({ airtable = false, kylas = false }) {
  const parts = [];
  if (airtable && !state.config.hasAirtableToken) {
    parts.push(`<label class="field"><span>Airtable personal access token</span>
      <input type="password" data-cred="airtableToken" value="${esc(
        state.credentials.airtableToken
      )}" placeholder="pat..." autocomplete="off" /></label>`);
  }
  if (kylas && !state.config.hasKylasKey) {
    parts.push(`<label class="field"><span>Kylas API key</span>
      <input type="password" data-cred="kylasApiKey" value="${esc(
        state.credentials.kylasApiKey
      )}" placeholder="Settings → API Keys" autocomplete="off" /></label>`);
  }
  if (!parts.length) return '';
  return `<div class="row">${parts.join('')}</div>
    <p class="hint">Keys stay in this browser tab and are sent only to your own server.</p>`;
}

function bindInputs(root) {
  for (const input of root.querySelectorAll('[data-cred]')) {
    input.addEventListener('input', () => {
      state.credentials[input.dataset.cred] = input.value.trim();
    });
  }
  for (const input of root.querySelectorAll('[data-bind]')) {
    const [group, key] = input.dataset.bind.split('.');
    input.addEventListener('input', () => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      if (key) state[group][key] = value;
      else state[group] = value;
    });
    input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      if (key) state[group][key] = value;
      else state[group] = value;
    });
  }
}

/* -------------------------------------------------------------- step 1a - */

function stepCsvSource() {
  return {
    title: 'Source · CSV file',
    summary: () =>
      state.csv ? `${state.csv.rowCount} rows · key: ${state.sourceKey}` : '',
    body() {
      const loaded = state.csv;
      return `
        ${errorNote()}
        <div class="drop" id="drop">
          <strong>${loaded ? esc(state.csv.name) : 'Choose a CSV file'}</strong>
          <span>${
            loaded
              ? `${state.csv.rowCount} rows · ${state.csv.columns.length} columns · click to replace`
              : 'or drag it here'
          }</span>
          <input type="file" id="file" accept=".csv,text/csv,text/plain" hidden />
        </div>
        <div id="csv-after">${loaded ? csvKeyPicker() : ''}</div>
      `;
    },
    mount(root) {
      const drop = root.querySelector('#drop');
      const file = root.querySelector('#file');

      drop.addEventListener('click', () => file.click());
      drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        drop.classList.add('over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('over');
        if (event.dataTransfer.files[0]) readFile(event.dataTransfer.files[0]);
      });
      file.addEventListener('change', () => {
        if (file.files[0]) readFile(file.files[0]);
      });

      async function readFile(chosen) {
        try {
          state.error = '';
          const text = await chosen.text();
          const parsed = await api('/csv/parse', { text });
          state.csv = { ...parsed, name: chosen.name };
          state.sourceKey = parsed.columns[0] || '';
          render();
        } catch (error) {
          state.error = error.message;
          render();
        }
      }

      wireCsvKeyPicker(root);
    },
  };
}

function csvKeyPicker() {
  const options = state.csv.columns
    .map((c) => `<option value="${esc(c)}" ${c === state.sourceKey ? 'selected' : ''}>${esc(c)}</option>`)
    .join('');
  const sample = state.csv.sample
    .slice(0, 3)
    .map((row) => preview(row[state.sourceKey]))
    .filter((v) => v !== '(empty)');

  return `
    <div class="row" style="margin-top:16px">
      <label class="field"><span>CSV primary key column</span>
        <select data-bind="sourceKey" id="csv-key">${options}</select>
      </label>
    </div>
    <p class="hint">Used to find the matching record in Airtable.${
      sample.length ? ` Sample values: ${esc(sample.join(', '))}` : ''
    }</p>
    ${footer()}
  `;
}

function wireCsvKeyPicker(root) {
  const select = root.querySelector('#csv-key');
  if (select) {
    select.addEventListener('change', () => {
      state.sourceKey = select.value;
      root.querySelector('#csv-after').innerHTML = csvKeyPicker();
      wireCsvKeyPicker(root);
    });
  }
  wireNext(root, async () => {
    if (!state.csv) throw new Error('Upload a CSV first.');
    if (!state.sourceKey) throw new Error('Pick a primary key column.');
  });
}

/* -------------------------------------------------------------- step 1b - */

function airtableForm(target, legend) {
  const cfg = state[target];
  const views = (state[target === 'source' ? 'sourceViews' : 'destinationViews'] || [])
    .map((v) => `<option value="${esc(v.name)}" ${v.name === cfg.view ? 'selected' : ''}>${esc(v.name)}</option>`)
    .join('');

  return `
    <div class="row">
      <label class="field"><span>Base ID</span>
        <input type="text" data-bind="${target}.baseId" value="${esc(cfg.baseId)}" placeholder="app..." />
      </label>
      <label class="field"><span>Table name</span>
        <input type="text" data-bind="${target}.table" value="${esc(cfg.table)}" placeholder="Contacts" />
      </label>
    </div>
    <div class="row">
      <label class="field"><span>View name <span style="opacity:.6">(optional)</span></span>
        ${
          views
            ? `<select data-bind="${target}.view"><option value="">All records</option>${views}</select>`
            : `<input type="text" data-bind="${target}.view" value="${esc(cfg.view)}" placeholder="Grid view" />`
        }
      </label>
    </div>
    ${credentialFields({ airtable: true })}
    <p class="hint">${esc(legend)}</p>
  `;
}

function stepAirtableSource() {
  return {
    title: 'Source · Airtable',
    summary: () =>
      `${state.source.table}${state.source.view ? ` / ${state.source.view}` : ''} · key: ${state.sourceKey}`,
    body() {
      return `
        ${errorNote()}
        ${airtableForm('source', 'The Base ID is in your Airtable API docs URL — it starts with "app".')}
        <div id="src-key">${state.sourceFields.length ? sourceKeyPicker() : ''}</div>
        ${footer(state.sourceFields.length ? 'Continue' : 'Load fields')}
      `;
    },
    mount(root) {
      bindInputs(root);
      wireNext(root, async () => {
        if (!state.source.baseId || !state.source.table) {
          throw new Error('Base ID and table name are required.');
        }
        // First press loads the table's fields; second press advances.
        if (!state.sourceFields.length) {
          const data = await api('/airtable/fields', state.source);
          if (!data.fields.length) throw new Error('No fields found in that table.');
          state.sourceFields = data.fields;
          state.sourceViews = data.views;
          state.sourceKey = state.sourceKey || data.fields[0].name;
          return false;
        }
        if (!state.sourceKey) throw new Error('Pick a primary key field.');
        return true;
      });
    },
  };
}

function sourceKeyPicker() {
  const options = state.sourceFields
    .map(
      (f) =>
        `<option value="${esc(f.name)}" ${f.name === state.sourceKey ? 'selected' : ''}>${esc(f.name)}</option>`
    )
    .join('');
  return `
    <div class="row">
      <label class="field"><span>Airtable primary key field</span>
        <select data-bind="sourceKey">${options}</select>
      </label>
    </div>
    <p class="hint">Its value is used to find the matching record in the destination.</p>
  `;
}

/* -------------------------------------------------------------- step 2a - */

function stepAirtableDestination() {
  return {
    title: 'Destination · Airtable',
    summary: () => `${state.destination.table}${state.destination.view ? ` / ${state.destination.view}` : ''}`,
    body() {
      return `
        ${errorNote()}
        ${airtableForm('destination', 'Records are matched, then only your mapped fields are patched.')}
        ${footer(state.destinationFields.length ? 'Continue' : 'Load fields')}
      `;
    },
    mount(root) {
      bindInputs(root);
      wireNext(root, async () => {
        if (!state.destination.baseId || !state.destination.table) {
          throw new Error('Base ID and table name are required.');
        }
        const data = await api('/airtable/fields', state.destination);
        state.destinationFields = data.fields.filter((f) => !f.readOnly);
        state.destinationViews = data.views;
        if (!state.destinationFields.length) throw new Error('No writable fields found in that table.');
        state.destinationKey = state.destinationKey || state.destinationFields[0]?.name || '';
      });
    },
  };
}

/* -------------------------------------------------------------- step 2b - */

function stepKylasDestination() {
  return {
    title: 'Destination · Kylas',
    summary: () => {
      const entity = state.config.entities.find((e) => e.value === state.destination.entity);
      return entity ? entity.label : '';
    },
    body() {
      const options = state.config.entities
        .map(
          (e) =>
            `<option value="${esc(e.value)}" ${
              e.value === state.destination.entity ? 'selected' : ''
            }>${esc(e.label)}</option>`
        )
        .join('');
      const current = state.config.entities.find((e) => e.value === state.destination.entity);

      return `
        ${errorNote()}
        <div class="row">
          <label class="field"><span>Entity type</span>
            <select data-bind="destination.entity">${options}</select>
          </label>
        </div>
        ${credentialFields({ kylas: true })}
        <div class="note info">
          <strong>Strict partial updates.</strong> ${
            current?.partialUpdate === 'json-patch'
              ? 'This entity is updated with a JSON Patch containing only your mapped fields.'
              : 'This entity has no PATCH route, so the record is read, your mapped fields are merged in, and the original owner is re-sent explicitly. Ownership is re-checked after every write.'
          }
        </div>
        ${footer('Load Kylas fields')}
      `;
    },
    mount(root) {
      bindInputs(root);
      root.querySelector('[data-bind="destination.entity"]')?.addEventListener('change', () => {
        state.destinationFields = [];
        state.destinationKey = '';
        state.mappings = [];
        render();
      });
      wireNext(root, async () => {
        const data = await api('/kylas/fields', { entity: state.destination.entity });
        state.destinationFields = data.fields;
        if (!state.destinationFields.length) {
          throw new Error('No writable fields returned for that entity. Check the API key permissions.');
        }
        state.destinationKey = state.destinationKey || state.destinationFields[0]?.name || '';
      });
    },
  };
}

/* --------------------------------------------------------------- step 3 - */

function sourceColumns() {
  return state.workflow === 'csv-to-airtable'
    ? (state.csv?.columns || [])
    : state.sourceFields.map((f) => f.name);
}

function destinationLabel(field) {
  return field.custom ? `${field.label} (custom)` : field.label || field.name;
}

function stepKeyMatch() {
  return {
    title: 'Match · primary key',
    summary: () => `${state.sourceKey} = ${state.destinationKey}`,
    body() {
      const options = state.destinationFields
        .map(
          (f) =>
            `<option value="${esc(f.name)}" data-custom="${f.custom ? '1' : ''}" ${
              f.name === state.destinationKey ? 'selected' : ''
            }>${esc(destinationLabel(f))}</option>`
        )
        .join('');

      return `
        ${errorNote()}
        <div class="keymatch">
          <span>Match on</span>
          <code>${esc(state.sourceKey)}</code>
          <span>→</span>
          <code id="key-echo">${esc(state.destinationKey || '—')}</code>
        </div>
        <div class="row">
          <label class="field"><span>Destination primary key field</span>
            <select id="dest-key">${options}</select>
          </label>
        </div>
        <p class="hint">
          A record is updated only when this value matches exactly. Rows with no match, or with more
          than one match, are reported and skipped — never created or guessed.
        </p>
        ${footer()}
      `;
    },
    mount(root) {
      const select = root.querySelector('#dest-key');
      const sync = () => {
        state.destinationKey = select.value;
        state.destinationKeyIsCustom = select.selectedOptions[0]?.dataset.custom === '1';
        root.querySelector('#key-echo').textContent = select.value || '—';
      };
      sync();
      select.addEventListener('change', sync);
      wireNext(root, async () => {
        if (!state.destinationKey) throw new Error('Pick a destination primary key field.');
        if (!state.mappings.length) {
          // Seed one empty mapping row so step 4 opens ready to use.
          state.mappings = [{ source: '', target: '', mode: 'replace', custom: false }];
        }
      });
    },
  };
}

/* --------------------------------------------------------------- step 4 - */

const MODE_LABELS = {
  replace: 'Replace',
  append: 'Append',
  fillEmpty: 'Only if empty',
};

function stepMapping() {
  return {
    title: 'Map · fields to update',
    summary: () => `${state.mappings.filter((m) => m.source && m.target).length} field(s)`,
    body() {
      return `
        ${errorNote()}
        <div class="keymatch">
          <span>Matching on</span>
          <code>${esc(state.sourceKey)}</code>
          <span>→</span>
          <code>${esc(state.destinationKey)}</code>
          <span style="color:var(--muted)">· the key itself is never written</span>
        </div>
        <div class="map-head">
          <span>Source field</span><span></span><span>Updates destination field</span><span>How</span><span></span>
        </div>
        <div id="rows">${state.mappings.map((m, i) => mapRow(m, i)).join('')}</div>
        <div class="actions" style="margin-top:4px">
          <button type="button" class="ghost" id="add-row">+ Add field</button>
          <div class="spacer"></div>
        </div>
        <details class="adv">
          <summary>Advanced</summary>
          <div class="row">
            <label class="field"><span>Append separator</span>
              <input type="text" data-bind="options.separator" value="${esc(state.options.separator)}" />
            </label>
            ${
              state.workflow === 'csv-to-airtable'
                ? `<label class="field"><span>Airtable typecast</span>
                     <select data-bind="options.typecast">
                       <option value="">Off — reject values that do not fit the field</option>
                       <option value="1" ${state.options.typecast ? 'selected' : ''}>On — let Airtable coerce values</option>
                     </select>
                   </label>`
                : `<label class="field"><span>Limit source records <span style="opacity:.6">(0 = all)</span></span>
                     <input type="number" min="0" data-bind="options.limit" value="${Number(
                       state.options.limit
                     )}" />
                   </label>`
            }
          </div>
        </details>
        <p class="hint">
          <strong>Replace</strong> overwrites the destination value. <strong>Append</strong> adds to it
          without erasing what is there. <strong>Only if empty</strong> writes just to blank fields.
          Empty source values are always skipped.
        </p>
        ${footer('Preview changes')}
      `;
    },
    mount(root) {
      bindInputs(root);

      const rebuild = () => {
        root.querySelector('#rows').innerHTML = state.mappings.map((m, i) => mapRow(m, i)).join('');
        wireRows();
      };

      const wireRows = () => {
        for (const element of root.querySelectorAll('[data-map]')) {
          element.addEventListener('change', () => {
            const index = Number(element.dataset.index);
            const key = element.dataset.map;
            state.mappings[index][key] = element.value;
            if (key === 'target') {
              const field = state.destinationFields.find((f) => f.name === element.value);
              state.mappings[index].custom = Boolean(field?.custom);
            }
          });
        }
        for (const button of root.querySelectorAll('[data-del]')) {
          button.addEventListener('click', () => {
            state.mappings.splice(Number(button.dataset.del), 1);
            if (!state.mappings.length) {
              state.mappings.push({ source: '', target: '', mode: 'replace', custom: false });
            }
            rebuild();
          });
        }
      };

      wireRows();
      root.querySelector('#add-row').addEventListener('click', () => {
        state.mappings.push({ source: '', target: '', mode: 'replace', custom: false });
        rebuild();
      });

      wireNext(root, async () => {
        state.mappings = state.mappings.filter((m) => m.source && m.target);
        if (!state.mappings.length) throw new Error('Map at least one field.');

        const targets = state.mappings.map((m) => m.target);
        const duplicate = targets.find((t, i) => targets.indexOf(t) !== i);
        if (duplicate) throw new Error(`"${duplicate}" is mapped more than once.`);

        const protectedHit = targets.find((t) => state.config.protectedFields.includes(t.split('.')[0]));
        if (protectedHit) {
          throw new Error(`"${protectedHit}" is a protected field and cannot be written.`);
        }
        state.report = null;
      });
    },
  };
}

function mapRow(mapping, index) {
  const sources = ['<option value="">Choose…</option>']
    .concat(
      sourceColumns().map(
        (c) => `<option value="${esc(c)}" ${c === mapping.source ? 'selected' : ''}>${esc(c)}</option>`
      )
    )
    .join('');

  const targets = ['<option value="">Choose…</option>']
    .concat(
      state.destinationFields
        .filter((f) => !state.config.protectedFields.includes(f.name))
        .map(
          (f) =>
            `<option value="${esc(f.name)}" ${f.name === mapping.target ? 'selected' : ''}>${esc(
              destinationLabel(f)
            )}</option>`
        )
    )
    .join('');

  const modes = state.config.writeModes
    .map(
      (m) => `<option value="${m}" ${m === mapping.mode ? 'selected' : ''}>${MODE_LABELS[m] || m}</option>`
    )
    .join('');

  return `
    <div class="map-row">
      <select data-map="source" data-index="${index}">${sources}</select>
      <span class="arrow">→</span>
      <select data-map="target" data-index="${index}">${targets}</select>
      <select data-map="mode" data-index="${index}">${modes}</select>
      <button type="button" class="del" data-del="${index}" title="Remove">×</button>
    </div>
  `;
}

/* --------------------------------------------------------------- step 5 - */

function stepRun() {
  return {
    title: 'Preview & run',
    summary: () => (state.report ? `${state.report.summary.updated} updated` : ''),
    body() {
      return `
        ${errorNote()}
        <div class="keymatch">
          <span>Matching</span><code>${esc(state.sourceKey)}</code><span>→</span>
          <code>${esc(state.destinationKey)}</code>
          <span style="color:var(--muted)">· writing ${state.mappings.length} field(s)</span>
        </div>
        <div class="actions" style="margin-top:0">
          <button type="button" class="ghost" id="preview">Preview (no writes)</button>
          <button type="button" class="primary" id="run" ${state.report ? '' : 'disabled'}>Run sync</button>
          <div class="spacer"></div>
        </div>
        <p class="hint" id="run-hint">Preview first — Run stays disabled until you have seen what will change.</p>
        <div id="report">${state.report ? reportView(state.report) : ''}</div>
      `;
    },
    mount(root) {
      const previewButton = root.querySelector('#preview');
      const runButton = root.querySelector('#run');
      const reportEl = root.querySelector('#report');
      const hint = root.querySelector('#run-hint');

      const execute = async (dryRun, button) => {
        if (state.busy) return;
        state.busy = true;
        const original = button.innerHTML;
        button.innerHTML = '<span class="spin"></span>';
        previewButton.disabled = true;
        runButton.disabled = true;
        state.error = '';

        try {
          const payload =
            state.workflow === 'csv-to-airtable'
              ? {
                  rows: state.csv.rows,
                  sourceKey: state.sourceKey,
                  baseId: state.destination.baseId,
                  table: state.destination.table,
                  view: state.destination.view,
                  destinationKey: state.destinationKey,
                  mappings: state.mappings,
                  typecast: Boolean(state.options.typecast),
                  separator: state.options.separator,
                  dryRun,
                }
              : {
                  baseId: state.source.baseId,
                  table: state.source.table,
                  view: state.source.view,
                  sourceKey: state.sourceKey,
                  entity: state.destination.entity,
                  destinationKey: state.destinationKey,
                  destinationKeyIsCustom: state.destinationKeyIsCustom,
                  mappings: state.mappings,
                  separator: state.options.separator,
                  limit: Number(state.options.limit) || 0,
                  dryRun,
                };

          const path =
            state.workflow === 'csv-to-airtable'
              ? '/sync/csv-to-airtable'
              : '/sync/airtable-to-kylas';

          state.report = await api(path, payload);
          reportEl.innerHTML = reportView(state.report);
          hint.textContent = dryRun
            ? 'Nothing was written. Review the rows above, then press Run sync.'
            : 'Sync complete.';
        } catch (error) {
          state.error = error.message;
          reportEl.innerHTML = `<div class="note err">${esc(error.message)}</div>`;
        } finally {
          state.busy = false;
          button.innerHTML = original;
          previewButton.disabled = false;
          runButton.disabled = !state.report || state.report.dryRun === false;
        }
      };

      previewButton.addEventListener('click', () => execute(true, previewButton));
      runButton.addEventListener('click', () => execute(false, runButton));
    },
  };
}

function reportView(report) {
  const { summary } = report;
  const stats = [
    ['upd', report.dryRun ? 'To update' : 'Updated', summary.updated],
    ['', 'Unchanged', summary.unchanged],
    ['unm', 'No match', summary.unmatched],
    ['unm', 'Ambiguous', summary.ambiguous],
    ['err', 'Failed', summary.failed],
  ]
    .filter(([, , value]) => value > 0 || value === summary.updated)
    .map(
      ([cls, label, value]) =>
        `<div class="stat ${cls}"><b>${value}</b>${esc(label)}</div>`
    )
    .join('');

  const rows = report.results
    .slice(0, 200)
    .map((result) => {
      const changes = { ...(result.changes || {}), ...(result.customChanges || {}) };
      const detail = Object.keys(changes).length
        ? Object.entries(changes)
            .map(([field, value]) => `<b>${esc(field)}</b> ← ${esc(preview(value))}`)
            .join('<br>')
        : esc(result.reason || result.error || '—');

      return `<tr>
        <td><code>${esc(preview(result.key))}</code></td>
        <td><span class="pill ${esc(result.status)}">${esc(result.status)}</span></td>
        <td class="diff">${detail}</td>
      </tr>`;
    })
    .join('');

  const banner = report.dryRun
    ? '<div class="note info">Preview only — no data has been written.</div>'
    : summary.failed
    ? `<div class="note err">${summary.failed} record(s) failed. Details below.</div>`
    : `<div class="note ok">Sync complete. ${summary.updated} record(s) updated, unmapped data left untouched.</div>`;

  const truncated =
    report.results.length > 200
      ? `<p class="hint">Showing the first 200 of ${report.results.length} rows.</p>`
      : '';

  return `
    ${banner}
    <div class="stats">${stats}</div>
    <div class="scroll">
      <table class="results">
        <thead><tr><th>Key</th><th>Status</th><th>Changes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${truncated}
  `;
}

boot();
