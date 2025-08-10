// js/app.js

const ENUMERATE_THRESHOLD = 20;
const DB_PATH = 'data/oier_data.db';
const MAPPING_PATH = 'data/name_mapping.yml';

// ---- DOM Elements ----
const loader = document.getElementById('loader');
const loadingProgress = document.getElementById('loading-progress');
const appContent = document.getElementById('app-content');
const resultsArea = document.getElementById('results-area');
const addRecordBtn = document.getElementById('add-record-btn');
const recordContainer = document.getElementById('record-conditions-container');
const recordTemplate = document.getElementById('record-template');

// ---- Global State ----
let db;
let nameMapping;

// ---- Initialization ----
async function main() {
    try {
        const sqlPromise = initSqlJs({ locateFile: file => `js/${file}` });
        const dataPromise = fetch(DB_PATH).then(async (response) => {
            if (!response.ok) throw new Error(`Failed to fetch database: ${response.statusText}`);
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');
            let receivedLength = 0;
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                receivedLength += value.length;
                loadingProgress.textContent = `(${(receivedLength / 1024 / 1024).toFixed(2)} / ${(contentLength / 1024 / 1024).toFixed(2)} MB)`;
            }
            return new Uint8Array(await new Blob(chunks).arrayBuffer());
        });

        const mappingPromise = fetch(MAPPING_PATH).then(res => res.text()).then(yamlText => jsyaml.load(yamlText));

        const [SQL, dbData, mappingData] = await Promise.all([sqlPromise, dataPromise, mappingPromise]);
        
        db = new SQL.Database(dbData);
        nameMapping = mappingData;

        loader.style.display = 'none';
        appContent.classList.remove('d-none');
        setupEventListeners();
        addRecordBtn.click(); // Add one initial record condition
    } catch (err) {
        loader.innerHTML = `<div class="alert alert-danger">Error initializing application: ${err.message}</div>`;
        console.error(err);
    }
}

// ---- Event Listeners Setup ----
function setupEventListeners() {
    document.getElementById('ui-form').addEventListener('submit', handleUiFormSubmit);
    document.getElementById('yaml-form').addEventListener('submit', handleYamlFormSubmit);
    document.getElementById('luogu-form').addEventListener('submit', handleLuoguFormSubmit);
    addRecordBtn.addEventListener('click', () => {
        const clone = recordTemplate.cloneNode(true);
        clone.style.display = 'block';
        clone.removeAttribute('id');
        recordContainer.appendChild(clone);
    });
}

// ---- Form Handlers ----
function handleUiFormSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const config = {
        enroll_year_range: [getIntOrNull(formData.get('enroll_min')), getIntOrNull(formData.get('enroll_max'))],
        grade_range: [getIntOrNull(formData.get('grade_min')), getIntOrNull(formData.get('grade_max'))],
        records: []
    };

    const recordFields = ['record_year_min', 'record_year_max', 'record_rank_min', 'record_rank_max', 'record_score_min', 'record_score_max', 'record_province', 'record_contest_type', 'record_level_range'];
    const recordData = {};
    recordFields.forEach(field => recordData[field] = formData.getAll(field));

    for (let i = 0; i < recordData.record_year_min.length; i++) {
        const recordCond = {
            year_range: [getIntOrNull(recordData.record_year_min[i]), getIntOrNull(recordData.record_year_max[i])],
            rank_range: [getIntOrNull(recordData.record_rank_min[i]), getIntOrNull(recordData.record_rank_max[i])],
            score_range: [getFloatOrNull(recordData.record_score_min[i]), getFloatOrNull(recordData.record_score_max[i])],
            province: getListOrNull(recordData.record_province[i]),
            contest_type: getListOrNull(recordData.record_contest_type[i]),
            level_range: getListOrNull(recordData.record_level_range[i]),
        };
        if (Object.values(recordCond).some(v => v && (Array.isArray(v) ? v.length > 0 : v !== null) && v.toString() !== 'null,null')) {
            config.records.push(recordCond);
        }
    }
    executeQuery(config);
}

function handleYamlFormSubmit(event) {
    event.preventDefault();
    const yamlContent = new FormData(event.target).get('yaml_content');
    try {
        const config = jsyaml.load(yamlContent);
        executeQuery(config);
    } catch (e) {
        displayError(`YAML parsing failed: ${e.message}`);
    }
}

function handleLuoguFormSubmit(event) {
    event.preventDefault();
    const luoguContent = new FormData(event.target).get('luogu_content');
    const config = convertLuoguToConfig(luoguContent, nameMapping);
    executeQuery(config);
}

// ---- Luogu Parser Logic (JS version) ----
function convertLuoguToConfig(luoguText, mapping) {
    const contestMap = mapping.contest_mapping || {};
    const levelMap = mapping.level_mapping || {};
    
    const lines = luoguText.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const pattern = /\[(\d{4})\]\s*(.*)/;
    const records = [];

    for (let i = 0; i < lines.length - 1; i += 2) {
        const match = lines[i].match(pattern);
        if (!match) continue;

        const year = parseInt(match[1], 10);
        const luoguContest = match[2].trim();
        const luoguLevel = lines[i + 1].trim();

        const standardLevel = levelMap[luoguLevel];
        if (!standardLevel) continue;

        let standardContestType = null;
        for (const [key, value] of Object.entries(contestMap)) {
            if (luoguContest.includes(key)) {
                standardContestType = value;
                break;
            }
        }
        if (!standardContestType) continue;
        
        records.push({
            year_range: [year, year],
            contest_type: [standardContestType],
            level_range: [standardLevel],
        });
    }
    return { records };
}

// ---- Query Engine Logic (JS version) ----
function executeQuery(config) {
    if (!config) {
        displayError("Invalid or empty configuration.");
        return;
    }
    try {
        const results = findOiers(config);
        displayResults(results, config);
    } catch (e) {
        displayError(`Query execution failed: ${e.message}`);
        console.error(e);
    }
}

function findOiers(config) {
    // 1. OIer level filtering
    let oierConditions = [], oierValues = [];
    if (config.enroll_year_range && config.enroll_year_range.some(v => v !== null)) {
        const [minYr, maxYr] = config.enroll_year_range;
        if (minYr !== null) { oierConditions.push("enroll_middle >= ?"); oierValues.push(minYr); }
        if (maxYr !== null) { oierConditions.push("enroll_middle <= ?"); oierValues.push(maxYr); }
    }
    if (config.grade_range && config.grade_range.some(v => v !== null)) {
        const [minGrade, maxGrade] = config.grade_range;
        const currentYear = new Date().getFullYear();
        if (maxGrade !== null) { oierConditions.push("enroll_middle >= ?"); oierValues.push(currentYear - maxGrade + 7); }
        if (minGrade !== null) { oierConditions.push("enroll_middle <= ?"); oierValues.push(currentYear - minGrade + 7); }
    }

    let candidateUids = null;
    if (oierConditions.length > 0) {
        const stmt = db.prepare(`SELECT uid FROM OIer WHERE ${oierConditions.join(" AND ")}`);
        stmt.bind(oierValues);
        candidateUids = new Set();
        while (stmt.step()) candidateUids.add(stmt.get()[0]);
        stmt.free();
    }

    // 2. Record level filtering
    let enumerationMode = candidateUids && candidateUids.size < ENUMERATE_THRESHOLD;
    const recordConstraints = config.records || [];
    for (const constraint of recordConstraints) {
        const [whereClause, values] = buildWhereClauseAndValues(constraint);
        let finalValues = [...values];
        let finalWhere = whereClause;

        if (enumerationMode && candidateUids.size > 0) {
            const placeholders = Array(candidateUids.size).fill('?').join(',');
            finalWhere += ` AND r.oier_uid IN (${placeholders})`;
            finalValues.push(...Array.from(candidateUids));
        }

        const stmt = db.prepare(`SELECT DISTINCT r.oier_uid FROM Record r JOIN Contest c ON r.contest_id = c.id WHERE ${finalWhere}`);
        stmt.bind(finalValues);
        const uidsForThisConstraint = new Set();
        while (stmt.step()) uidsForThisConstraint.add(stmt.get()[0]);
        stmt.free();

        if (candidateUids === null) {
            candidateUids = uidsForThisConstraint;
        } else {
            candidateUids = new Set([...candidateUids].filter(uid => uidsForThisConstraint.has(uid)));
        }
        if (!enumerationMode && candidateUids && candidateUids.size < ENUMERATE_THRESHOLD) {
            enumerationMode = true;
        }
        if (candidateUids.size === 0) break;
    }

    // 3. Fetch final results
    if (candidateUids === null && oierConditions.length === 0 && recordConstraints.length === 0) {
        return db.exec("SELECT * FROM OIer ORDER BY oierdb_score DESC")[0]?.values || [];
    }
    if (!candidateUids || candidateUids.size === 0) return [];

    const placeholders = Array(candidateUids.size).fill('?').join(',');
    const stmt = db.prepare(`SELECT * FROM OIer WHERE uid IN (${placeholders}) ORDER BY oierdb_score DESC`);
    stmt.bind(Array.from(candidateUids));
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function buildWhereClauseAndValues(params) {
    let conditions = [], values = [];
    const rangeFields = {'year_range': 'c.year', 'score_range': 'r.score', 'rank_range': 'r.rank'};
    const listFields = {'province': 'r.province', 'level_range': 'r.level', 'contest_type': 'c.type'};

    for (const [field, column] of Object.entries(rangeFields)) {
        if (params[field] && params[field].some(v => v !== null)) {
            const [minV, maxV] = params[field];
            if (minV !== null) { conditions.push(`${column} >= ?`); values.push(minV); }
            if (maxV !== null) { conditions.push(`${column} <= ?`); values.push(maxV); }
        }
    }
    for (const [field, column] of Object.entries(listFields)) {
        if (params[field] && params[field].length > 0) {
            const placeholders = Array(params[field].length).fill('?').join(',');
            conditions.push(`${column} IN (${placeholders})`);
            values.push(...params[field]);
        }
    }
    return [conditions.length > 0 ? conditions.join(" AND ") : "1=1", values];
}


// ---- Display Logic ----
function displayResults(oiers, config) {
    // ... (和之前类似, 但现在是JS生成HTML)
    const genderMap = { 1: '男', '-1': '女', 0: '未知' };
    const cleanConfig = {}; // Clean config for display
    Object.entries(config).forEach(([key, value]) => {
        if(value && (Array.isArray(value) ? value.length > 0 && value.some(v => v !== null) : true)) {
            cleanConfig[key] = value;
        }
    });

    const configYaml = jsyaml.dump(cleanConfig, { skipInvalid: true, sortKeys: false });

    let tableRows = '';
    if (oiers.length > 0) {
        oiers.forEach(oier => {
            tableRows += `
                <tr>
                    <td>${oier.uid}</td>
                    <td>${oier.name}</td>
                    <td>${genderMap[oier.gender] || '?'}</td>
                    <td>${oier.enroll_middle}</td>
                    <td>${oier.oierdb_score.toFixed(2)}</td>
                    <td>${oier.ccf_score.toFixed(2)}</td>
                    <td>${oier.ccf_level}</td>
                </tr>
            `;
        });
    }

    const resultHtml = `
        <div class="accordion mb-4" id="configAccordion">
          <div class="accordion-item">
            <h2 class="accordion-header"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseOne"><strong>点击查看本次查询使用的 YAML 配置</strong></button></h2>
            <div id="collapseOne" class="accordion-collapse collapse"><div class="accordion-body"><pre><code>${configYaml}</code></pre></div></div>
          </div>
        </div>
        ${oiers.length > 0 ? `
            <p>共找到 ${oiers.length} 名符合条件的 OIer。</p>
            <table class="table table-striped table-hover">
                <thead><tr><th>UID</th><th>姓名</th><th>性别</th><th>入学年份</th><th>DB评分</th><th>CCF评分</th><th>CCF等级</th></tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        ` : `<div class="alert alert-warning">未找到符合所有条件的 OIer。</div>`}
    `;
    resultsArea.innerHTML = resultHtml;
}

function displayError(message) {
    resultsArea.innerHTML = `<div class="alert alert-danger">${message}</div>`;
}

// ---- Helper Functions ----
function getIntOrNull(value) { return value === '' || value === null ? null : parseInt(value, 10); }
function getFloatOrNull(value) { return value === '' || value === null ? null : parseFloat(value); }
function getListOrNull(value) { return value ? value.split(',').map(s => s.trim()).filter(Boolean) : null; }

// ---- Entry Point ----
main();
