// ==UserScript==
// @name         Remplissage Automatique V10 - OCR Documents
// @namespace    https://github.com/BiggerThanTheMall/tampermonkey-ltoa
// @version      10.1.1
// @description  Creation de fiche client automatique - API GEMINI
// @author       Sheana
// @match        https://courtage.modulr.fr/fr/scripts/clients/clients_manage.php*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
//
// @updateURL    https://raw.githubusercontent.com/BiggerThanTheMall/tampermonkey-ltoa/main/Modulr-Remplissage-Auto-OCR-V10.user.js
// @downloadURL  https://raw.githubusercontent.com/BiggerThanTheMall/tampermonkey-ltoa/main/Modulr-Remplissage-Auto-OCR-V10.user.js
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // CONFIGURATION
    // ============================================
    const CONFIG = {
        API_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/',
        MAX_TOKENS: 4096,
        TEMPERATURE: 0,
        MODEL_PRIORITY: [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash',
            'gemini-flash'
        ],
        DEFAULT_MODEL: 'gemini-2.0-flash',
        // Cache du modèle (12 heures - refresh plus fréquent)
        MODEL_CACHE_DURATION: 12 * 60 * 60 * 1000,
        SUPPORTED_TYPES: {
            'application/pdf': 'PDF',
            'image/jpeg': 'Image JPEG',
            'image/jpg': 'Image JPG',
            'image/png': 'Image PNG',
            'image/webp': 'Image WebP',
            'image/gif': 'Image GIF'
        },
        MAX_FILE_SIZE: 20 * 1024 * 1024
    };

    // ============================================
    // GESTION API KEY
    // ============================================
    let API_KEY = GM_getValue('gemini_api_key');
    if (!API_KEY) {
        API_KEY = prompt('🔑 Entrez votre clé API Gemini :');
        if (API_KEY && API_KEY.trim()) {
            GM_setValue('gemini_api_key', API_KEY.trim());
            alert('✅ Clé API enregistrée !');
        } else {
            alert('❌ Clé API requise');
            return;
        }
    }

    // ============================================
    // GESTION DU MODÈLE - AUTO-UPDATE
    // ============================================
    let currentModel = null;
    let modelReady = false;

    function loadModelFromCache() {
        const cached = GM_getValue('gemini_model_cache');
        if (cached) {
            try {
                const { model, timestamp } = JSON.parse(cached);
                if (Date.now() - timestamp < CONFIG.MODEL_CACHE_DURATION) {
                    currentModel = model;
                    console.log('[Model] Cache valide:', model);
                    return true;
                }
            } catch (e) {}
        }
        currentModel = GM_getValue('gemini_last_working_model') || CONFIG.DEFAULT_MODEL;
        console.log('[Model] Cache expiré, fallback:', currentModel);
        return false;
    }

    async function detectBestModel(silent = false) {
        if (!silent) showMessage('🔍 Mise à jour du modèle IA...', 'info', 3000);
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
            );
            if (!response.ok) throw new Error(`Erreur API: ${response.status}`);
            const data = await response.json();
            const availableModels = data.models || [];

            const flashModels = availableModels.filter(m => {
                const name = m.name.replace('models/', '');
                return name.includes('flash') && m.supportedGenerationMethods?.includes('generateContent');
            });

            for (const priority of CONFIG.MODEL_PRIORITY) {
                const match = flashModels.find(m => {
                    const name = m.name.replace('models/', '');
                    return name.startsWith(priority) || name === priority;
                });
                if (match) {
                    const modelName = match.name.replace('models/', '');
                    saveModelToCache(modelName);
                    if (!silent) showMessage(`✅ Modèle: ${modelName}`, 'success');
                    return modelName;
                }
            }

            if (flashModels.length > 0) {
                const fallback = flashModels[0].name.replace('models/', '');
                saveModelToCache(fallback);
                if (!silent) showMessage(`✅ Modèle: ${fallback}`, 'success');
                return fallback;
            }
            throw new Error('Aucun modèle Flash disponible');
        } catch (err) {
            console.error('[Model] Erreur détection:', err);
            return currentModel;
        }
    }

    function saveModelToCache(model) {
        currentModel = model;
        GM_setValue('gemini_model_cache', JSON.stringify({ model, timestamp: Date.now() }));
        GM_setValue('gemini_last_working_model', model);
        updateModelDisplay();
    }

    // Auto-init du modèle au démarrage
    async function initModel() {
        const cacheValid = loadModelFromCache();
        modelReady = true;
        updateModelDisplay();
        // Refresh en background si cache expiré
        if (!cacheValid) {
            await detectBestModel(true);
        }
    }

    // ============================================
    // APPEL API GEMINI
    // ============================================
    async function callGeminiAPI(contents, retryCount = 0) {
        const apiUrl = `${CONFIG.API_ENDPOINT}${currentModel}:generateContent?key=${API_KEY}`;
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents,
                    generationConfig: { maxOutputTokens: CONFIG.MAX_TOKENS, temperature: CONFIG.TEMPERATURE }
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error('[API] Erreur:', response.status, errorBody);

                if (response.status === 429) {
                    throw new Error('⏳ Trop de requêtes ! Attendez 1 minute.');
                }
                // 404 = modèle obsolète → re-détecter
                if (response.status === 404 && retryCount < 1) {
                    showMessage('🔄 Modèle obsolète, mise à jour...', 'info', 3000);
                    GM_deleteValue('gemini_model_cache');
                    await detectBestModel(true);
                    return callGeminiAPI(contents, retryCount + 1);
                }
                if (response.status === 503 && retryCount < 2) {
                    await new Promise(r => setTimeout(r, 1000));
                    return callGeminiAPI(contents, retryCount + 1);
                }
                throw new Error(`Erreur ${response.status}`);
            }

            GM_setValue('gemini_last_working_model', currentModel);
            return await response.json();
        } catch (err) {
            if (err.message.includes('Trop de requêtes') || err.message.includes('429')) throw err;
            if (retryCount < 2 && !err.message.includes('Erreur')) {
                await new Promise(r => setTimeout(r, 1000));
                return callGeminiAPI(contents, retryCount + 1);
            }
            throw err;
        }
    }

    // ============================================
    // UTILITAIRES
    // ============================================
    function showMessage(message, type = 'info', duration = 5000) {
        let box = document.getElementById('ai-msg');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ai-msg';
            document.body.appendChild(box);
            box.style.cssText = `
                position:fixed;top:24px;right:24px;padding:20px 24px;border-radius:22px;font-size:15px;
                font-weight:500;z-index:10000;max-width:340px;box-shadow:0 16px 48px rgba(0,0,0,0.14);
                backdrop-filter:blur(50px);-webkit-backdrop-filter:blur(50px);
                transition:opacity 0.3s,transform 0.3s;opacity:0;transform:translateY(-30px) scale(0.9);
            `;
        }
        box.innerHTML = message;
        if (type === 'error') {
            box.style.background = 'linear-gradient(135deg, rgba(255,69,58,0.95), rgba(255,69,58,0.9))';
            box.style.color = '#fff';
        } else if (type === 'success') {
            box.style.background = 'linear-gradient(135deg, rgba(52,199,89,0.95), rgba(52,199,89,0.9))';
            box.style.color = '#fff';
        } else {
            box.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.95), rgba(255,255,255,0.9))';
            box.style.color = '#1d1d1f';
        }
        setTimeout(() => { box.style.opacity = '1'; box.style.transform = 'translateY(0) scale(1)'; }, 10);
        setTimeout(() => { box.style.opacity = '0'; box.style.transform = 'translateY(-30px) scale(0.9)'; }, duration);
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // ============================================
    // NORMALISATION DES DATES → DD/MM/YYYY
    // ============================================
    function normalizeDate(dateStr) {
        if (!dateStr || dateStr.trim() === '') return '';
        dateStr = dateStr.trim();

        // Déjà au format DD/MM/YYYY
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;

        // Format YYYY-MM-DD ou YYYY/MM/DD
        let m = dateStr.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;

        // Format DD-MM-YYYY
        m = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (m) return `${m[1]}/${m[2]}/${m[3]}`;

        // Format DD.MM.YYYY
        m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (m) return `${m[1]}/${m[2]}/${m[3]}`;

        // Format MM/DD/YYYY (si jour > 12, on sait que c'est DD/MM)
        m = dateStr.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
        if (m) {
            const a = parseInt(m[1]), b = parseInt(m[2]), y = m[3];
            // Si premier > 12, c'est forcément le jour
            if (a > 12) return `${String(a).padStart(2,'0')}/${String(b).padStart(2,'0')}/${y}`;
            // Sinon on suppose DD/MM/YYYY (convention française)
            return `${String(a).padStart(2,'0')}/${String(b).padStart(2,'0')}/${y}`;
        }

        // Retourner tel quel en remplaçant les tirets par des slashes
        return dateStr.replace(/-/g, '/');
    }

    // ============================================
    // MAPPING COMPLET DES CHAMPS MODULR
    // ============================================

    // Mapping nationalité texte → code ISO
    const NATIONALITY_MAP = {
        'afghane': 'AFG', 'angolaise': 'AGO', 'albanaise': 'ALB', 'andorrane': 'AND',
        'emirienne': 'ARE', 'argentine': 'ARG', 'arménienne': 'ARM', 'australienne': 'AUS',
        'autrichienne': 'AUT', 'azerbaïdjanaise': 'AZE', 'belge': 'BEL', 'béninoise': 'BEN',
        'bangladaise': 'BGD', 'bulgare': 'BGR', 'brésilienne': 'BRA', 'canadienne': 'CAN',
        'suisse': 'CHE', 'chilienne': 'CHL', 'chinoise': 'CHN', 'ivoirienne': 'CIV',
        'camerounaise': 'CMR', 'congolaise': 'COG', 'colombienne': 'COL', 'comorienne': 'COM',
        'allemande': 'DEU', 'djiboutienne': 'DJI', 'danoise': 'DNK', 'algérienne': 'DZA',
        'egyptienne': 'EGY', 'espagnole': 'ESP', 'estonienne': 'EST', 'ethiopienne': 'ETH',
        'finlandaise': 'FIN', 'française': 'FRA', 'gabonaise': 'GAB', 'britannique': 'GBR',
        'géorgienne': 'GEO', 'ghanéenne': 'GHA', 'guinéenne': 'GIN', 'gambienne': 'GMB',
        'grecque': 'GRC', 'hellénique': 'GRC', 'guatemaltèque': 'GTM', 'haïtienne': 'HTI',
        'hongroise': 'HUN', 'indonésienne': 'IDN', 'indienne': 'IND', 'irlandaise': 'IRL',
        'iranienne': 'IRN', 'irakienne': 'IRQ', 'islandaise': 'ISL', 'israélienne': 'ISR',
        'italienne': 'ITA', 'jamaïcaine': 'JAM', 'jordanienne': 'JOR', 'japonaise': 'JPN',
        'kenyane': 'KEN', 'cambodgienne': 'KHM', 'sud-coréenne': 'KOR', 'koweïtienne': 'KWT',
        'libanaise': 'LBN', 'libyenne': 'LBY', 'lituanienne': 'LTU', 'luxembourgeoise': 'LUX',
        'lettone': 'LVA', 'marocaine': 'MAR', 'monégasque': 'MCO', 'moldave': 'MDA',
        'malgache': 'MDG', 'mexicaine': 'MEX', 'malienne': 'MLI', 'maltaise': 'MLT',
        'mongole': 'MNG', 'mauritanienne': 'MRT', 'mauricienne': 'MUS', 'malaisienne': 'MYS',
        'nigérienne': 'NER', 'nigériane': 'NGA', 'néerlandaise': 'NLD', 'norvégienne': 'NOR',
        'népalaise': 'NPL', 'néo-zélandaise': 'NZL', 'pakistanaise': 'PAK', 'péruvienne': 'PER',
        'philippine': 'PHL', 'polonaise': 'POL', 'portugaise': 'PRT', 'paraguayenne': 'PRY',
        'palestinienne': 'PSE', 'roumaine': 'ROU', 'russe': 'RUS', 'rwandaise': 'RWA',
        'saoudienne': 'SAU', 'soudanaise': 'SDN', 'sénégalaise': 'SEN', 'singapourienne': 'SGP',
        'slovaque': 'SVK', 'slovène': 'SVN', 'somalienne': 'SOM', 'serbe': 'SRB',
        'suédoise': 'SWE', 'syrienne': 'SYR', 'tchadienne': 'TCD', 'togolaise': 'TGO',
        'thaïlandaise': 'THA', 'tunisienne': 'TUN', 'turque': 'TUR', 'taiwanaise': 'TWN',
        'tanzanienne': 'TZA', 'ougandaise': 'UGA', 'ukrainienne': 'UKR', 'uruguayenne': 'URY',
        'américaine': 'USA', 'vénézuélienne': 'VEN', 'vietnamienne': 'VNM',
        'sud-africaine': 'ZAF', 'zambienne': 'ZMB', 'zimbabwéenne': 'ZWE',
        'congolaise (kinshasa)': 'COD', 'équatorienne': 'ECU', 'cubaine': 'CUB',
        'croate': 'HRV', 'tchèque': 'CZE', 'dominicaine': 'DOM'
    };

    // Mapping pays de naissance texte → code ISO
    const BIRTH_COUNTRY_MAP = {
        'afghanistan': 'AFG', 'afrique du sud': 'ZAF', 'albanie': 'ALB', 'algérie': 'DZA', 'algerie': 'DZA',
        'allemagne': 'DEU', 'andorre': 'AND', 'angola': 'AGO', 'argentine': 'ARG', 'arménie': 'ARM',
        'australie': 'AUS', 'autriche': 'AUT', 'azerbaïdjan': 'AZE', 'belgique': 'BEL', 'bénin': 'BEN',
        'bangladesh': 'BGD', 'bulgarie': 'BGR', 'brésil': 'BRA', 'bresil': 'BRA', 'cambodge': 'KHM',
        'cameroun': 'CMR', 'canada': 'CAN', 'chili': 'CHL', 'chine': 'CHN', 'colombie': 'COL',
        'comores': 'COM', 'congo': 'COG', 'corée du sud': 'KOR', 'côte d\'ivoire': 'CIV',
        'cote d\'ivoire': 'CIV', 'croatie': 'HRV', 'cuba': 'CUB', 'danemark': 'DNK',
        'djibouti': 'DJI', 'egypte': 'EGY', 'espagne': 'ESP', 'estonie': 'EST',
        'etats-unis': 'USA', 'états-unis': 'USA', 'usa': 'USA', 'ethiopie': 'ETH',
        'finlande': 'FIN', 'france': 'FRA', 'gabon': 'GAB', 'gambie': 'GMB', 'géorgie': 'GEO',
        'ghana': 'GHA', 'grèce': 'GRC', 'grece': 'GRC', 'guinée': 'GIN', 'guinee': 'GIN',
        'haïti': 'HTI', 'haiti': 'HTI', 'hongrie': 'HUN', 'inde': 'IND', 'indonésie': 'IDN',
        'iran': 'IRN', 'iraq': 'IRQ', 'irak': 'IRQ', 'irlande': 'IRL', 'islande': 'ISL',
        'israël': 'ISR', 'israel': 'ISR', 'italie': 'ITA', 'jamaïque': 'JAM', 'japon': 'JPN',
        'jordanie': 'JOR', 'kenya': 'KEN', 'liban': 'LBN', 'libye': 'LBY', 'lituanie': 'LTU',
        'luxembourg': 'LUX', 'madagascar': 'MDG', 'malaisie': 'MYS', 'mali': 'MLI',
        'malte': 'MLT', 'maroc': 'MAR', 'maurice': 'MUS', 'ile maurice': 'MUS',
        'mauritanie': 'MRT', 'mexique': 'MEX', 'moldavie': 'MDA', 'monaco': 'MCO',
        'mongolie': 'MNG', 'monténégro': 'MNE', 'mozambique': 'MOZ', 'népal': 'NPL',
        'niger': 'NER', 'nigeria': 'NGA', 'norvège': 'NOR', 'norvege': 'NOR',
        'nouvelle-zélande': 'NZL', 'pakistan': 'PAK', 'palestine': 'PSE', 'panama': 'PAN',
        'pays-bas': 'NLD', 'pérou': 'PER', 'perou': 'PER', 'philippines': 'PHL',
        'pologne': 'POL', 'portugal': 'PRT', 'qatar': 'QAT', 'roumanie': 'ROU',
        'royaume-uni': 'GBR', 'russie': 'RUS', 'rwanda': 'RWA', 'sénégal': 'SEN', 'senegal': 'SEN',
        'serbie': 'SRB', 'singapour': 'SGP', 'slovaquie': 'SVK', 'slovénie': 'SVN',
        'somalie': 'SOM', 'soudan': 'SDN', 'sri lanka': 'LKA', 'suède': 'SWE', 'suede': 'SWE',
        'suisse': 'CHE', 'syrie': 'SYR', 'taïwan': 'TWN', 'tanzanie': 'TZA', 'tchad': 'TCD',
        'thaïlande': 'THA', 'thailande': 'THA', 'togo': 'TGO', 'tunisie': 'TUN',
        'turquie': 'TUR', 'ukraine': 'UKR', 'uruguay': 'URY', 'venezuela': 'VEN',
        'vietnam': 'VNM', 'yémen': 'YEM', 'zambie': 'ZMB', 'zimbabwe': 'ZWE',
        'la réunion': 'REU', 'reunion': 'REU', 'martinique': 'MTQ', 'guadeloupe': 'GLP',
        'guyane': 'GUF', 'guyane française': 'GUF', 'mayotte': 'MYT',
        'nouvelle-calédonie': 'NCL', 'polynésie française': 'PYF', 'corse': 'COR'
    };

    // Mapping pays pour le champ "country" (adresse) - en MAJUSCULES comme dans Modulr
    const COUNTRY_ADDRESS_MAP = {
        'france': 'FRANCE', 'belgique': 'BELGIQUE', 'suisse': 'SUISSE', 'luxembourg': 'LUXEMBOURG',
        'allemagne': 'ALLEMAGNE', 'espagne': 'ESPAGNE', 'italie': 'ITALIE', 'portugal': 'PORTUGAL',
        'royaume-uni': 'ROYAUME-UNI', 'pays-bas': 'PAYS-BAS', 'etats-unis': 'ETATS-UNIS',
        'canada': 'CANADA', 'maroc': 'MAROC', 'algérie': 'ALGERIE', 'algerie': 'ALGERIE',
        'tunisie': 'TUNISIE', 'sénégal': 'SENEGAL', 'senegal': 'SENEGAL', 'cameroun': 'CAMEROUN',
        'côte d\'ivoire': 'COTE D\'IVOIRE', 'madagascar': 'MADAGASCAR', 'mali': 'MALI',
        'guinée': 'GUINEE', 'guinee': 'GUINEE', 'gabon': 'GABON', 'congo': 'CONGO_ REP.',
        'togo': 'TOGO', 'bénin': 'BENIN', 'benin': 'BENIN', 'niger': 'NIGER',
        'burkina faso': 'BURKINA FASO', 'tchad': 'TCHAD', 'mauritanie': 'MAURITANIE',
        'djibouti': 'DJIBOUTI', 'comores': 'COMORES', 'mayotte': 'MAYOTTE',
        'la réunion': 'LA REUNION', 'reunion': 'LA REUNION', 'martinique': 'MARTINIQUE',
        'guadeloupe': 'GUADELOUPE', 'guyane': 'GUYANE FRANCAISE',
        'nouvelle-calédonie': 'NOUVELLE-CALEDONIE', 'polynésie française': 'POLYNESIE FRANCAISE',
        'monaco': 'MONACO', 'andorre': 'ANDORRE', 'liban': 'LIBAN', 'turquie': 'TURQUIE',
        'roumanie': 'ROUMANIE', 'pologne': 'POLOGNE', 'grèce': 'GRECE', 'grece': 'GRECE',
        'russie': 'RUSSIE_ FEDERATION DE', 'chine': 'CHINE', 'japon': 'JAPON', 'inde': 'INDE',
        'brésil': 'BRESIL', 'bresil': 'BRESIL', 'mexique': 'MEXIQUE', 'australie': 'AUSTRALIE',
        'ile maurice': 'ILE MAURICE', 'maurice': 'ILE MAURICE'
    };

    // Mapping situation matrimoniale
    const MARITAL_STATUS_MAP = {
        'marié': '1', 'mariée': '1', 'marie': '1', 'married': '1', 'marié(e)': '1',
        'divorcé': '2', 'divorcée': '2', 'divorce': '2', 'divorced': '2', 'divorcé(e)': '2',
        'célibataire': '3', 'celibataire': '3', 'single': '3',
        'veuf': '4', 'veuve': '4', 'veuf(ve)': '4',
        'concubin': '5', 'concubine': '5', 'concubin(e)': '5', 'union libre': '5',
        'pacsé': '6', 'pacsée': '6', 'pacse': '6', 'pacs': '6', 'pacsé(e)': '6'
    };

    // Mapping forme juridique
    const LEGAL_FORM_MAP = {
        'micro-entreprise': '72', 'micro entreprise': '72', 'microentreprise': '72', 'auto-entrepreneur': '72', 'autoentrepreneur': '72',
        'entreprise individuelle': '73', 'ei': '73',
        'eurl': '74',
        'sarl': '75',
        'sa': '76',
        'sas': '77',
        'sasu': '78',
        'association': '79',
        'sci': '80',
        'snc': '81',
        'sca': '205', 'société en commandite par actions': '205'
    };

    function findNationalityCode(text) {
        if (!text) return '';
        const lower = text.toLowerCase().trim();
        // Cherche correspondance directe
        if (NATIONALITY_MAP[lower]) return NATIONALITY_MAP[lower];
        // Cherche correspondance partielle
        for (const [key, code] of Object.entries(NATIONALITY_MAP)) {
            if (lower.includes(key) || key.includes(lower)) return code;
        }
        return '';
    }

    function findBirthCountryCode(text) {
        if (!text) return '';
        const lower = text.toLowerCase().trim();
        if (BIRTH_COUNTRY_MAP[lower]) return BIRTH_COUNTRY_MAP[lower];
        for (const [key, code] of Object.entries(BIRTH_COUNTRY_MAP)) {
            if (lower.includes(key) || key.includes(lower)) return code;
        }
        return '';
    }

    function findCountryAddressValue(text) {
        if (!text) return 'FRANCE';
        const lower = text.toLowerCase().trim();
        if (COUNTRY_ADDRESS_MAP[lower]) return COUNTRY_ADDRESS_MAP[lower];
        // Essaie en majuscules directement (déjà au bon format ?)
        const upper = text.toUpperCase().trim();
        const countrySelect = document.querySelector('select#country');
        if (countrySelect) {
            for (const opt of countrySelect.options) {
                if (opt.value === upper || opt.value === text) return opt.value;
                if (opt.text.toLowerCase() === lower) return opt.value;
            }
        }
        return 'FRANCE';
    }

    function findMaritalStatusValue(text) {
        if (!text) return '';
        const lower = text.toLowerCase().trim();
        if (MARITAL_STATUS_MAP[lower]) return MARITAL_STATUS_MAP[lower];
        for (const [key, val] of Object.entries(MARITAL_STATUS_MAP)) {
            if (lower.includes(key)) return val;
        }
        return '';
    }

    function findLegalFormValue(text) {
        if (!text) return '';
        const lower = text.toLowerCase().trim();
        if (LEGAL_FORM_MAP[lower]) return LEGAL_FORM_MAP[lower];
        for (const [key, val] of Object.entries(LEGAL_FORM_MAP)) {
            if (lower.includes(key) || key.includes(lower)) return val;
        }
        return '';
    }

    // ============================================
    // REMPLISSAGE CRM - TOUS LES CHAMPS
    // ============================================
    function setInputValue(selector, value) {
        if (!value) return;
        const el = document.querySelector(selector);
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setSelectValue(selector, value) {
        if (!value) return;
        const el = document.querySelector(selector);
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof jQuery !== 'undefined') {
            try {
                jQuery(el).trigger('change');
                jQuery(el).multipleSelect('refresh');
            } catch(e) {}
        }
    }

    function clickRadio(name, value) {
        const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
        if (radio) {
            radio.checked = true;
            radio.click();
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function fillCrmFields(data) {
        console.log('[CRM] Remplissage complet:', data);

        // ── TYPE CLIENT ──
        if (data.clientType) {
            const typeMap = { 'Individual': '0', 'Company': '1', 'TNS': '2' };
            const typeValue = typeMap[data.clientType] || '0';
            clickRadio('selectItemclient[type]', typeValue);
        }

        setTimeout(() => {
            // ── CIVILITÉ ──
            if (data.civility && (data.clientType === 'Individual' || data.clientType === 'TNS')) {
                setTimeout(() => {
                    const civilityMap = { 'Monsieur': '1', 'M.': '1', 'Madame': '2', 'Mme': '2', 'Mlle': '3', 'M. et Mme': '4', 'M. et Mlle': '5', 'Dr': '6', 'Me': '7' };
                    const val = civilityMap[data.civility] || '0';
                    if (val !== '0') clickRadio('selectItemclient[title]', val);
                }, 300);
            }

            // ── NOM / PRÉNOM ──
            if (data.clientType === 'Individual' || data.clientType === 'TNS') {
                setInputValue('input[name="client[last_name]"]', data.lastName);
                setInputValue('input[name="client[first_name]"]', data.firstName);
                setInputValue('input[name="client[additional_name]"]', data.additionalName);
            }

            // ── SOCIÉTÉ (Company/TNS) ──
            if (data.clientType === 'Company' || data.clientType === 'TNS') {
                setInputValue('input[name="client[company]"]', data.organization);
                setInputValue('input[name="client[business_name]"]', data.businessName);

                // Forme juridique
                if (data.legalForm) {
                    const legalVal = findLegalFormValue(data.legalForm);
                    if (legalVal) setSelectValue('select[name="client[legal_form]"]', legalVal);
                }

                // SIRET
                if (data.siret) {
                    setTimeout(() => {
                        setInputValue('input[name="client[registration_number]"]', data.siret);
                        // Clic auto sur le bouton SIRET
                        setTimeout(() => {
                            const siretBtn = document.querySelector('span.fa.fa-sync-alt[data-callback="Modulr.Client.Form.ImportCompanyInformation"]');
                            if (siretBtn && !siretBtn.classList.contains('disabled')) {
                                showMessage('🔄 Récupération SIRET...', 'info');
                                siretBtn.click();
                            }
                        }, 800);
                    }, 500);
                }

                // FINESS
                setInputValue('input[name="client[finess_number]"]', data.finessNumber);
                // Code APE/NAF
                setInputValue('input[name="client[business_sector]"]', data.apeCode);
                // Capital social
                setInputValue('input[name="client[share_capital]"]', data.shareCapital);
                // Date immatriculation
                if (data.registrationDate) {
                    setInputValue('input[name="client[registration_date]"]', normalizeDate(data.registrationDate));
                }
                // Effectifs
                setInputValue('input[name="client[workforce]"]', data.workforce);
                // Chiffre d'affaires
                setInputValue('input[name="client[turnover]"]', data.turnover);
                // Résultat
                setInputValue('input[name="client[income]"]', data.income);

                // Pour TNS: aussi le nom/prénom du dirigeant
                if (data.clientType === 'TNS') {
                    setInputValue('input[name="client[last_name]"]', data.lastName);
                    setInputValue('input[name="client[first_name]"]', data.firstName);
                }
            }

            // ── INFORMATIONS PERSONNELLES ──
            if (data.birthDate) {
                setInputValue('input[name="client[birth_date]"]', normalizeDate(data.birthDate));
            }
            setInputValue('input[name="client[birth_name]"]', data.birthName);
            setInputValue('input[name="client[birth_postal_code]"]', data.birthPostalCode);
            setInputValue('input[name="client[birth_location]"]', data.birthLocation);

            // Pays de naissance
            if (data.birthCountry) {
                const bcc = findBirthCountryCode(data.birthCountry);
                if (bcc) setSelectValue('select[name="client[birth_country]"]', bcc);
            }

            // Nationalité
            if (data.nationality) {
                const nc = findNationalityCode(data.nationality);
                if (nc) setSelectValue('select[name="client[nationality]"]', nc);
            }
            if (data.nationality2) {
                const nc2 = findNationalityCode(data.nationality2);
                if (nc2) setSelectValue('select[name="client[nationality_2]"]', nc2);
            }

            // Profession
            setInputValue('input[name="client[occupation]"]', data.occupation || data.jobTitle);

            // Situation matrimoniale
            if (data.maritalStatus) {
                const ms = findMaritalStatusValue(data.maritalStatus);
                if (ms) setSelectValue('select[name="client[marital_status]"]', ms);
            }

            // ── CONJOINT ──
            setInputValue('input[name="client[spouse_last_name]"]', data.spouseLastName);
            setInputValue('input[name="client[spouse_first_name]"]', data.spouseFirstName);
            setInputValue('input[name="client[spouse_email]"]', data.spouseEmail);
            setInputValue('input[name="client[spouse_mobile_phone]"]', data.spouseMobilePhone);
            if (data.spouseBirthDate) {
                setInputValue('input[name="client[spouse_birth_date]"]', normalizeDate(data.spouseBirthDate));
            }

            // ── ADRESSE ──
            setInputValue('input[name="client[address_1]"]', data.streetAddress);
            setInputValue('input[name="client[address_2]"]', data.streetAddress2);
            setInputValue('input[name="client[address_3]"]', data.streetAddress3);
            setInputValue('input[name="client[postal_code]"]', data.zipCode);
            setInputValue('input[name="client[city]"]', data.city);

            // Pays
            setTimeout(() => {
                const countryVal = findCountryAddressValue(data.country || 'France');
                setSelectValue('select[name="client[country]"]', countryVal);
            }, 500);

            // ── TÉLÉPHONES & EMAILS ──
            setInputValue('input[name="client[phone_1]"]', data.homePhone);
            setInputValue('input[name="client[phone_2]"]', data.professionalPhoneNumber);
            setInputValue('input[name="client[mobile_phone]"]', data.mobilePhoneNumber);
            setInputValue('input[name="client[fax]"]', data.fax);
            setInputValue('input[name="client[email]"]', data.email);
            setInputValue('input[name="client[email_2]"]', data.email2);
            setInputValue('input[name="client[website]"]', data.website);
            setInputValue('input[name="client[facebook]"]', data.facebook);
            setInputValue('input[name="client[twitter]"]', data.twitter);

            // ── INFORMATIONS BANCAIRES ──
            setInputValue('input[name="client[iban]"]', data.iban);
            setInputValue('input[name="client[bic]"]', data.bic);
            setInputValue('input[name="client[bank_name]"]', data.bankName);
            setInputValue('input[name="client[bank_domiciliation]"]', data.bankDomiciliation);
            setInputValue('input[name="client[bank_account_holder]"]', data.bankAccountHolder);

            // ── NOTES ──
            if (data.notes) {
                const notesEl = document.querySelector('textarea[name="client[notes]"]');
                if (notesEl) { notesEl.value = data.notes; notesEl.dispatchEvent(new Event('input', { bubbles: true })); }
            }

            showMessage('✅ Formulaire rempli !', 'success');
        }, 800);
    }

    // ============================================
    // PARSING JSON ROBUSTE
    // ============================================
    function parseJsonRobust(jsonText) {
        jsonText = jsonText.replace(/^```json\s*/g, '').replace(/^```\s*/g, '').replace(/\s*```$/g, '');
        const firstBrace = jsonText.indexOf('{');
        const lastBrace = jsonText.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace >= 0) {
            jsonText = jsonText.substring(firstBrace, lastBrace + 1);
        }
        try {
            return JSON.parse(jsonText);
        } catch (e) {
            console.warn('[IA] JSON tronqué, extraction manuelle...');
            const extract = (key) => (jsonText.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))||[])[1] || '';
            return {
                clientType: extract('clientType') || 'Individual',
                civility: extract('civility'),
                firstName: extract('firstName'),
                lastName: extract('lastName'),
                additionalName: extract('additionalName'),
                email: extract('email'),
                email2: extract('email2'),
                mobilePhoneNumber: extract('mobilePhoneNumber'),
                professionalPhoneNumber: extract('professionalPhoneNumber'),
                homePhone: extract('homePhone'),
                fax: extract('fax'),
                streetAddress: extract('streetAddress'),
                streetAddress2: extract('streetAddress2'),
                streetAddress3: extract('streetAddress3'),
                zipCode: extract('zipCode'),
                city: extract('city'),
                country: extract('country') || 'France',
                occupation: extract('occupation'),
                jobTitle: extract('jobTitle'),
                organization: extract('organization'),
                businessName: extract('businessName'),
                birthDate: extract('birthDate'),
                birthName: extract('birthName'),
                birthPostalCode: extract('birthPostalCode'),
                birthLocation: extract('birthLocation'),
                birthCountry: extract('birthCountry'),
                nationality: extract('nationality'),
                nationality2: extract('nationality2'),
                maritalStatus: extract('maritalStatus'),
                siret: extract('siret'),
                legalForm: extract('legalForm'),
                apeCode: extract('apeCode'),
                finessNumber: extract('finessNumber'),
                shareCapital: extract('shareCapital'),
                registrationDate: extract('registrationDate'),
                workforce: extract('workforce'),
                turnover: extract('turnover'),
                income: extract('income'),
                website: extract('website'),
                facebook: extract('facebook'),
                twitter: extract('twitter'),
                iban: extract('iban'),
                bic: extract('bic'),
                bankName: extract('bankName'),
                bankDomiciliation: extract('bankDomiciliation'),
                bankAccountHolder: extract('bankAccountHolder'),
                spouseLastName: extract('spouseLastName'),
                spouseFirstName: extract('spouseFirstName'),
                spouseEmail: extract('spouseEmail'),
                spouseMobilePhone: extract('spouseMobilePhone'),
                spouseBirthDate: extract('spouseBirthDate'),
                notes: extract('notes')
            };
        }
    }

    // ============================================
    // SCHEMA JSON COMPLET POUR GEMINI
    // ============================================
    const FULL_JSON_SCHEMA = `{
  "clientType":"",
  "civility":"",
  "firstName":"",
  "lastName":"",
  "additionalName":"",
  "email":"",
  "email2":"",
  "mobilePhoneNumber":"",
  "professionalPhoneNumber":"",
  "homePhone":"",
  "fax":"",
  "streetAddress":"",
  "streetAddress2":"",
  "streetAddress3":"",
  "zipCode":"",
  "city":"",
  "country":"France",
  "occupation":"",
  "jobTitle":"",
  "organization":"",
  "businessName":"",
  "legalForm":"",
  "siret":"",
  "apeCode":"",
  "finessNumber":"",
  "shareCapital":"",
  "registrationDate":"",
  "workforce":"",
  "turnover":"",
  "income":"",
  "birthDate":"",
  "birthName":"",
  "birthPostalCode":"",
  "birthLocation":"",
  "birthCountry":"",
  "nationality":"",
  "nationality2":"",
  "maritalStatus":"",
  "spouseLastName":"",
  "spouseFirstName":"",
  "spouseEmail":"",
  "spouseMobilePhone":"",
  "spouseBirthDate":"",
  "website":"",
  "facebook":"",
  "twitter":"",
  "iban":"",
  "bic":"",
  "bankName":"",
  "bankDomiciliation":"",
  "bankAccountHolder":"",
  "notes":""
}`;

    // ============================================
    // PROMPT COMMUN (RÈGLES)
    // ============================================
    const COMMON_RULES = `
RÈGLES IMPORTANTES:
1. TOUTES les dates DOIVENT être au format DD/MM/YYYY avec des slashes (jamais de tirets). Exemple: 24/11/1994
2. clientType = "Individual" (particulier), "Company" (société), ou "TNS" (travailleur non salarié)
3. civility = "Monsieur", "Madame", "Mlle", "Dr", "Me" ou "M. et Mme" selon le contexte
4. Pour les entreprises: renseigner organization (dénomination), businessName (raison sociale), legalForm (SARL, SAS, EURL, SASU, SA, SCI, SNC, etc.), siret, apeCode (code NAF/APE), shareCapital, registrationDate, workforce, turnover
5. Pour TNS: renseigner à la fois les infos entreprise ET le nom/prénom du dirigeant
6. nationality et birthCountry en texte français (ex: "Algérienne", "Algérie")
7. maritalStatus = "Marié(e)", "Divorcé(e)", "Célibataire", "Veuf(ve)", "Concubin(e)" ou "Pacsé(e)"
8. Extrais TOUS les champs possibles. Si une info est présente, elle DOIT être dans le JSON.
9. Laisse vide ("") les champs non trouvés.
10. country = pays de résidence/adresse. birthCountry = pays de naissance. Ce sont 2 champs différents.

RÈGLES COUPLE / CONJOINT (TRÈS IMPORTANT):
11. Si le texte contient 2 personnes (un homme et une femme, "M. et Mme", un couple):
    - La PREMIÈRE personne listée = CLIENT PRINCIPAL → remplis firstName, lastName, email, mobilePhoneNumber, birthDate, etc.
    - La DEUXIÈME personne = CONJOINT → remplis spouseFirstName, spouseLastName, spouseEmail, spouseMobilePhone, spouseBirthDate
    - Si "M. et Mme" ou "Monsieur et Madame" → civility = "M. et Mme", maritalStatus = "Marié(e)"
    - Le nom de famille du client principal va dans lastName. Si le conjoint a le même nom, remplis quand même spouseLastName.
12. Si le texte mentionne "Monsieur DUPONT Marc" et "Madame DUPONT Marie":
    - Client principal: lastName="DUPONT", firstName="Marc", civility="Monsieur"
    - Conjoint: spouseLastName="DUPONT", spouseFirstName="Marie"
    - maritalStatus = "Marié(e)" (déduit du couple)
    - civility = "M. et Mme" (car on a les deux)
13. Si une seule personne est mentionnée avec "marié(e)" mais sans détails du conjoint, remplis juste maritalStatus sans inventer les infos conjoint.`;

    // ============================================
    // PROMPTS PAR TYPE DE DOCUMENT
    // ============================================
    function getPromptForDocument(docType) {
        const base = `Analyse ce document et extrait TOUTES les informations possibles. Réponds UNIQUEMENT en JSON valide sans markdown.`;

        const prompts = {
            'cni': `${base}
Document: CARTE NATIONALE D'IDENTITÉ française
Extrais: nom, prénom, nom de naissance, date de naissance (DD/MM/YYYY), sexe, lieu de naissance, adresse.
- clientType = "Individual"
- civility = "Monsieur" si sexe M, "Madame" si sexe F
- birthName = nom de naissance (si différent du nom d'usage)
- birthLocation = lieu de naissance
- birthCountry = pays de naissance (souvent en bas de la CNI)
- nationality = déduis de la CNI (ex: "Française")
${COMMON_RULES}`,

            'permis': `${base}
Document: PERMIS DE CONDUIRE français
Extrais: nom, prénom, date de naissance (DD/MM/YYYY), adresse complète, lieu de naissance.
- clientType = "Individual"
- Déduis civility du prénom
${COMMON_RULES}`,

            'passeport': `${base}
Document: PASSEPORT
Extrais: nom, prénom, date de naissance (DD/MM/YYYY), sexe, lieu de naissance, nationalité, pays émetteur.
- clientType = "Individual"
- civility = "Monsieur" si sexe M, "Madame" si sexe F
- nationality = nationalité inscrite
- birthCountry = pays de naissance
${COMMON_RULES}`,

            'kbis': `${base}
Document: EXTRAIT KBIS / K-BIS
Extrais TOUT: dénomination sociale, raison sociale, SIRET (14 chiffres), SIREN (9 chiffres), adresse du siège, forme juridique, code APE/NAF, capital social, date d'immatriculation, effectifs, nom du dirigeant/gérant, numéro FINESS si présent.
- Si forme juridique = EURL, SASU, auto-entrepreneur, EI → clientType = "TNS", extrais nom/prénom dirigeant
- Sinon → clientType = "Company"
- organization = dénomination sociale
- businessName = raison sociale
- legalForm = forme juridique exacte (SARL, SAS, etc.)
- apeCode = code APE/NAF
- shareCapital = capital social (nombre uniquement)
- registrationDate = date immatriculation (DD/MM/YYYY)
${COMMON_RULES}`,

            'rib': `${base}
Document: RIB / Relevé d'Identité Bancaire
Extrais: IBAN, BIC, nom banque, domiciliation, titulaire du compte, adresse.
- Renseigne iban, bic, bankName, bankDomiciliation, bankAccountHolder
${COMMON_RULES}`,

            'facture': `${base}
Document: FACTURE / COURRIER
Extrais: nom/raison sociale du destinataire, adresse complète, SIRET, email, téléphone, numéro TVA.
${COMMON_RULES}`,

            'auto': `${base}
Document: TYPE INCONNU - Analyse automatique
Identifie le type (CNI, permis, passeport, KBIS, facture, RIB, courrier...) et extrait TOUTES les informations:
- Particulier: nom, prénom, date naissance, lieu naissance, pays naissance, nationalité, adresse, téléphone, email, situation matrimoniale, profession, conjoint
- Entreprise: raison sociale, dénomination, SIRET, forme juridique, code APE, capital, effectifs, CA, adresse siège, dirigeant, FINESS
- Bancaire: IBAN, BIC, banque, domiciliation, titulaire
- Déduis clientType: "Individual", "Company" ou "TNS"
${COMMON_RULES}`
        };

        return prompts[docType] || prompts['auto'];
    }

    // ============================================
    // EXTRACTION DEPUIS FICHIER (OCR)
    // ============================================
    async function extractFromFile(file, docType = 'auto') {
        console.log('[OCR] Fichier:', file.name, file.type, file.size);

        if (!CONFIG.SUPPORTED_TYPES[file.type]) {
            showMessage(`❌ Type non supporté: ${file.type}`, 'error');
            return;
        }
        if (file.size > CONFIG.MAX_FILE_SIZE) {
            showMessage(`❌ Fichier trop volumineux (max ${CONFIG.MAX_FILE_SIZE / 1024 / 1024} MB)`, 'error');
            return;
        }

        showMessage(`📄 Analyse de ${file.name}...`, 'info', 15000);
        setButtonsDisabled(true);

        try {
            const base64Data = await fileToBase64(file);
            const prompt = getPromptForDocument(docType) + `\n\nJSON attendu:\n${FULL_JSON_SCHEMA}`;

            let mimeType = file.type;
            if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

            const contents = [{
                role: "user",
                parts: [
                    { inline_data: { mime_type: mimeType, data: base64Data } },
                    { text: prompt }
                ]
            }];

            const result = await callGeminiAPI(contents);

            if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
                if (result.promptFeedback?.blockReason) throw new Error(`Contenu bloqué: ${result.promptFeedback.blockReason}`);
                throw new Error('Réponse vide de Gemini');
            }

            const data = parseJsonRobust(result.candidates[0].content.parts[0].text);
            console.log('[OCR] Données extraites:', data);

            if (!data.country) data.country = 'France';
            fillCrmFields(data);
            showMessage('✅ Document analysé !', 'success');

        } catch (err) {
            console.error('[OCR] Erreur:', err);
            showMessage(`❌ ${err.message}`, 'error');
        } finally {
            setButtonsDisabled(false);
        }
    }

    // ============================================
    // EXTRACTION DEPUIS TEXTE
    // ============================================
    async function extractFromText(text) {
        if (!text.trim()) {
            showMessage("Collez du texte d'abord", 'error');
            return;
        }

        showMessage("🤖 Extraction en cours...", 'info', 10000);
        setButtonsDisabled(true);

        try {
            const prompt = `Extrait TOUTES les données client du texte suivant. Réponds UNIQUEMENT en JSON valide.

${COMMON_RULES}

Texte à analyser:
---
${text}
---

JSON attendu:
${FULL_JSON_SCHEMA}`;

            const contents = [{ role: "user", parts: [{ text: prompt }] }];
            const result = await callGeminiAPI(contents);

            if (!result.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error('Réponse vide');

            const data = parseJsonRobust(result.candidates[0].content.parts[0].text);
            if (!data.country) data.country = 'France';

            // Fallback SIRET: chercher dans le texte brut
            if (!data.siret) {
                const siretMatch = text.match(/\b\d{14}\b/);
                if (siretMatch) data.siret = siretMatch[0];
            }

            fillCrmFields(data);
            showMessage('✅ Extraction réussie !', 'success');

        } catch (err) {
            console.error('[IA] Erreur:', err);
            showMessage(`❌ ${err.message}`, 'error');
        } finally {
            setButtonsDisabled(false);
        }
    }

    // ============================================
    // UI UTILITIES
    // ============================================
    function setButtonsDisabled(disabled) {
        document.querySelectorAll('.ai-btn-primary, .ai-btn-file').forEach(btn => {
            btn.disabled = disabled;
        });
    }

    function updateModelDisplay() {
        const el = document.querySelector('.ai-model-info');
        if (el) el.textContent = `Modèle: ${currentModel}`;
    }

    // ============================================
    // INTERFACE
    // ============================================
    function initUI() {
        const style = document.createElement('style');
        style.textContent = `
            .ai-container {
                position:fixed;top:10px;right:10px;width:460px;border-radius:36px;z-index:9999;
                box-shadow:0 24px 64px -16px rgba(0,0,0,0.12),0 0 0 0.5px rgba(255,255,255,0.9);
                backdrop-filter:blur(60px) saturate(220%);-webkit-backdrop-filter:blur(60px) saturate(220%);
                background:linear-gradient(135deg,rgba(255,255,255,0.85) 0%,rgba(255,255,255,0.75) 50%,rgba(255,255,255,0.85) 100%);
                border:1px solid rgba(255,255,255,0.95);animation:slideIn 0.8s cubic-bezier(0.16,1,0.3,1);
                font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;
            }
            .ai-container.minimized{display:none}
            @keyframes slideIn{from{opacity:0;transform:translateY(30px) scale(0.94)}to{opacity:1;transform:translateY(0) scale(1)}}
            .ai-header{padding:28px 28px 24px;background:linear-gradient(180deg,rgba(255,255,255,0.3) 0%,rgba(255,255,255,0.05) 100%);border-bottom:0.5px solid rgba(0,0,0,0.05);border-radius:36px 36px 0 0;position:relative}
            .ai-minimize{position:absolute;top:28px;right:28px;width:32px;height:32px;border:none;border-radius:50%;background:rgba(0,0,0,0.05);color:rgba(0,0,0,0.5);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
            .ai-minimize:hover{background:rgba(0,0,0,0.1)}
            .ai-title{font-size:24px;font-weight:600;background:linear-gradient(135deg,#2c2c2e 0%,#48484a 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:0 0 6px 0}
            .ai-subtitle{font-size:13px;color:rgba(0,0,0,0.45);margin:0}
            .ai-status{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:100px;background:rgba(52,199,89,0.12);font-size:12px;color:#34C759;margin-top:12px}
            .ai-status-dot{width:6px;height:6px;border-radius:50%;background:#34C759;animation:pulse 2s ease-in-out infinite}
            @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
            .ai-content{padding:24px 28px 28px}
            .ai-tabs{display:flex;gap:8px;margin-bottom:20px}
            .ai-tab{flex:1;padding:12px;border:none;border-radius:12px;background:rgba(0,0,0,0.04);color:rgba(0,0,0,0.6);font-size:13px;font-weight:500;cursor:pointer;transition:all 0.2s}
            .ai-tab:hover{background:rgba(0,0,0,0.08)}
            .ai-tab.active{background:linear-gradient(180deg,#007AFF 0%,#0051D5 100%);color:#fff}
            .ai-panel{display:none}.ai-panel.active{display:block}
            .ai-label{display:block;font-size:13px;font-weight:500;color:rgba(0,0,0,0.6);margin-bottom:10px}
            .ai-textarea{width:100%;height:160px;padding:16px;border:none;border-radius:16px;background:rgba(248,248,248,0.8);color:#1d1d1f;font-size:14px;resize:vertical;box-sizing:border-box;margin-bottom:16px}
            .ai-textarea:focus{outline:none;background:#fff;box-shadow:0 0 0 2px rgba(0,122,255,0.3)}
            .ai-file-zone{border:2px dashed rgba(0,0,0,0.15);border-radius:16px;padding:30px 20px;text-align:center;margin-bottom:16px;cursor:pointer;transition:all 0.3s}
            .ai-file-zone:hover,.ai-file-zone.dragover{border-color:#007AFF;background:rgba(0,122,255,0.05)}
            .ai-file-zone-icon{font-size:36px;margin-bottom:10px}
            .ai-file-zone-text{font-size:14px;color:rgba(0,0,0,0.6);margin-bottom:6px}
            .ai-file-zone-hint{font-size:11px;color:rgba(0,0,0,0.4)}
            .ai-file-input{display:none}
            .ai-file-preview{display:none;padding:12px;border-radius:12px;background:rgba(52,199,89,0.1);margin-bottom:16px;font-size:13px;color:#34C759}
            .ai-file-preview.visible{display:flex;align-items:center;gap:10px}
            .ai-file-preview-name{flex:1;overflow:hidden;text-overflow:ellipsis}
            .ai-file-preview-remove{background:none;border:none;color:#FF3B30;cursor:pointer;font-size:16px}
            .ai-select{width:100%;padding:14px 16px;border:none;border-radius:12px;background:rgba(0,0,0,0.04);font-size:14px;margin-bottom:16px;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;line-height:1.4}
            .ai-select:focus{outline:none;box-shadow:0 0 0 2px rgba(0,122,255,0.3)}
            .ai-btn-primary,.ai-btn-file{width:100%;padding:16px;border:none;border-radius:16px;background:linear-gradient(180deg,#007AFF 0%,#0051D5 100%);color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:12px;box-shadow:0 4px 16px rgba(0,122,255,0.3);transition:all 0.3s}
            .ai-btn-primary:hover,.ai-btn-file:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,122,255,0.4)}
            .ai-btn-primary:disabled,.ai-btn-file:disabled{opacity:0.5;cursor:not-allowed;transform:none}
            .ai-btn-file{background:linear-gradient(180deg,#34C759 0%,#28A745 100%);box-shadow:0 4px 16px rgba(52,199,89,0.3)}
            .ai-btn-file:hover{box-shadow:0 8px 24px rgba(52,199,89,0.4)}
            .ai-btn-secondary{flex:1;padding:12px;border:none;border-radius:12px;background:rgba(0,0,0,0.04);color:rgba(0,0,0,0.6);font-size:13px;cursor:pointer}
            .ai-btn-secondary:hover{background:rgba(0,0,0,0.08)}
            .ai-footer{display:flex;gap:8px;margin-top:8px}
            .ai-model-info{font-size:11px;color:rgba(0,0,0,0.35);text-align:center;margin-top:12px}
            .ai-fab{position:fixed;bottom:90px;right:24px;width:60px;height:60px;border:none;border-radius:50%;background:linear-gradient(180deg,#007AFF 0%,#0051D5 100%);color:#fff;font-size:24px;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:9998;box-shadow:0 8px 24px rgba(0,122,255,0.35)}
            .ai-fab.visible{display:flex}
            .ai-fab:hover{transform:scale(1.1)}
        `;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.className = 'ai-container';
        container.innerHTML = `
            <div class="ai-header">
                <button class="ai-minimize">−</button>
                <h2 class="ai-title">Remplissage Auto</h2>
                <p class="ai-subtitle">IA + OCR · V10.1 · Tous champs + Conjoint</p>
                <div class="ai-status">
                    <span class="ai-status-dot"></span>
                    Connecté
                </div>
            </div>
            <div class="ai-content">
                <div class="ai-tabs">
                    <button class="ai-tab active" data-tab="text">📝 Texte</button>
                    <button class="ai-tab" data-tab="file">📄 Document</button>
                </div>
                <div id="panel-text" class="ai-panel active">
                    <label class="ai-label">Collez le texte client</label>
                    <textarea id="ai-input" class="ai-textarea" placeholder="Collez ici les informations du client (email, signature, fiche, texte libre...)"></textarea>
                    <button id="extract-text-btn" class="ai-btn-primary">✨ Extraire et remplir</button>
                </div>
                <div id="panel-file" class="ai-panel">
                    <label class="ai-label">Type de document</label>
                    <select id="doc-type" class="ai-select">
                        <option value="auto">🔍 Détection automatique</option>
                        <option value="cni">🪪 Carte d'identité (CNI)</option>
                        <option value="permis">🚗 Permis de conduire</option>
                        <option value="passeport">✈️ Passeport</option>
                        <option value="kbis">🏢 Extrait KBIS</option>
                        <option value="rib">🏦 RIB</option>
                        <option value="facture">🧾 Facture / Courrier</option>
                    </select>
                    <div id="file-zone" class="ai-file-zone">
                        <div class="ai-file-zone-icon">📁</div>
                        <div class="ai-file-zone-text">Glissez un fichier ici</div>
                        <div class="ai-file-zone-hint">ou cliquez pour sélectionner (PDF, JPG, PNG)</div>
                    </div>
                    <input type="file" id="file-input" class="ai-file-input" accept=".pdf,.jpg,.jpeg,.png,.webp,.gif">
                    <div id="file-preview" class="ai-file-preview">
                        <span>📄</span>
                        <span id="file-name" class="ai-file-preview-name"></span>
                        <button id="file-remove" class="ai-file-preview-remove">✕</button>
                    </div>
                    <button id="extract-file-btn" class="ai-btn-file" disabled>📤 Analyser le document</button>
                </div>
                <div class="ai-footer">
                    <button id="reset-key" class="ai-btn-secondary">🔑 Changer clé API</button>
                </div>
                <p class="ai-model-info">Chargement...</p>
            </div>
        `;
        document.body.prepend(container);

        const fab = document.createElement('button');
        fab.className = 'ai-fab';
        fab.innerHTML = '✨';
        document.body.appendChild(fab);

        // === EVENTS ===
        container.querySelector('.ai-minimize').onclick = () => {
            container.classList.add('minimized');
            fab.classList.add('visible');
        };
        fab.onclick = () => {
            container.classList.remove('minimized');
            fab.classList.remove('visible');
        };

        container.querySelectorAll('.ai-tab').forEach(tab => {
            tab.onclick = () => {
                container.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
                container.querySelectorAll('.ai-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
            };
        });

        // File upload
        const fileZone = document.getElementById('file-zone');
        const fileInput = document.getElementById('file-input');
        const filePreview = document.getElementById('file-preview');
        const fileName = document.getElementById('file-name');
        const extractFileBtn = document.getElementById('extract-file-btn');
        let selectedFile = null;

        fileZone.onclick = () => fileInput.click();
        fileZone.ondragover = (e) => { e.preventDefault(); fileZone.classList.add('dragover'); };
        fileZone.ondragleave = () => fileZone.classList.remove('dragover');
        fileZone.ondrop = (e) => {
            e.preventDefault();
            fileZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
        };
        fileInput.onchange = () => { if (fileInput.files.length) handleFileSelect(fileInput.files[0]); };

        function handleFileSelect(file) {
            if (!CONFIG.SUPPORTED_TYPES[file.type]) {
                showMessage(`❌ Type non supporté: ${file.type}`, 'error');
                return;
            }
            selectedFile = file;
            fileName.textContent = file.name;
            filePreview.classList.add('visible');
            fileZone.style.display = 'none';
            extractFileBtn.disabled = false;
        }

        document.getElementById('file-remove').onclick = () => {
            selectedFile = null;
            fileInput.value = '';
            filePreview.classList.remove('visible');
            fileZone.style.display = 'block';
            extractFileBtn.disabled = true;
        };

        extractFileBtn.onclick = () => {
            if (selectedFile) extractFromFile(selectedFile, document.getElementById('doc-type').value);
        };

        document.getElementById('extract-text-btn').onclick = () => {
            extractFromText(document.getElementById('ai-input').value);
        };

        document.getElementById('reset-key').onclick = () => {
            if (confirm('Supprimer la clé API ?')) {
                GM_deleteValue('gemini_api_key');
                GM_deleteValue('gemini_model_cache');
                GM_deleteValue('gemini_last_working_model');
                location.reload();
            }
        };

        // Init modèle auto
        initModel();
    }

    window.addEventListener('load', initUI);
})();
