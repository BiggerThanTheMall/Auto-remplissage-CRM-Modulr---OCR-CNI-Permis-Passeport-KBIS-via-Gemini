// ==UserScript==
// @name         Remplissage Automatique V9 - OCR Documents
// @namespace    https://github.com/BiggerThanTheMall/tampermonkey-ltoa
// @version      9.2.3
// @description  Auto-remplissage CRM Modulr - OCR CNI/Permis/Passeport/KBIS via Gemini
// @author       Sheana
// @match        https://courtage.modulr.fr/fr/scripts/clients/clients_manage.php*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
//
// @updateURL    https://raw.githubusercontent.com/BiggerThanTheMall/tampermonkey-ltoa/main/Modulr-Remplissage-Auto-OCR-V9.user.js
// @downloadURL  https://raw.githubusercontent.com/BiggerThanTheMall/tampermonkey-ltoa/main/Modulr-Remplissage-Auto-OCR-V9.user.js
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
        // Priorité des modèles Flash (du plus récent au plus ancien)
        MODEL_PRIORITY: [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash',
            'gemini-flash'
        ],
        // Modèle par défaut si aucun cache
        DEFAULT_MODEL: 'gemini-2.0-flash',
        // Cache du modèle (7 jours)
        MODEL_CACHE_DURATION: 7 * 24 * 60 * 60 * 1000,
        // Types de fichiers supportés
        SUPPORTED_TYPES: {
            'application/pdf': 'PDF',
            'image/jpeg': 'Image JPEG',
            'image/jpg': 'Image JPG',
            'image/png': 'Image PNG',
            'image/webp': 'Image WebP',
            'image/gif': 'Image GIF'
        },
        MAX_FILE_SIZE: 20 * 1024 * 1024 // 20 MB max
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
    // GESTION DU MODÈLE
    // ============================================
    let currentModel = null;

    // Charge le modèle depuis le cache SANS appel API (instantané)
    function loadModelFromCache() {
        const cached = GM_getValue('gemini_model_cache');
        if (cached) {
            try {
                const { model, timestamp } = JSON.parse(cached);
                if (Date.now() - timestamp < CONFIG.MODEL_CACHE_DURATION) {
                    currentModel = model;
                    console.log('[Model] Cache:', model);
                    return model;
                }
            } catch (e) {}
        }
        // Fallback sur le dernier modèle qui a fonctionné ou le défaut
        currentModel = GM_getValue('gemini_last_working_model') || CONFIG.DEFAULT_MODEL;
        console.log('[Model] Fallback:', currentModel);
        return currentModel;
    }

    // Détection complète (appelée SEULEMENT si erreur 404 ou clic manuel)
    async function detectBestModel(showNotification = true) {
        if (showNotification) showMessage('🔍 Recherche du meilleur modèle...', 'info', 3000);

        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
            );

            if (!response.ok) throw new Error(`Erreur API: ${response.status}`);

            const data = await response.json();
            const availableModels = data.models || [];

            console.log('[Model] Modèles disponibles:', availableModels.map(m => m.name));

            // Filtrer les modèles Flash qui supportent generateContent
            const flashModels = availableModels.filter(m => {
                const name = m.name.replace('models/', '');
                const isFlash = name.includes('flash');
                const supportsGenerate = m.supportedGenerationMethods?.includes('generateContent');
                return isFlash && supportsGenerate;
            });

            console.log('[Model] Modèles Flash disponibles:', flashModels.map(m => m.name));

            // Trouver le meilleur modèle selon notre priorité
            for (const priority of CONFIG.MODEL_PRIORITY) {
                const match = flashModels.find(m => {
                    const name = m.name.replace('models/', '');
                    return name.startsWith(priority) || name === priority;
                });
                if (match) {
                    const modelName = match.name.replace('models/', '');
                    console.log('[Model] Meilleur modèle trouvé:', modelName);
                    saveModelToCache(modelName);
                    if (showNotification) showMessage(`✅ Modèle: ${modelName}`, 'success');
                    return modelName;
                }
            }

            // Fallback: prendre le premier modèle Flash disponible
            if (flashModels.length > 0) {
                const fallback = flashModels[0].name.replace('models/', '');
                console.log('[Model] Fallback sur:', fallback);
                saveModelToCache(fallback);
                if (showNotification) showMessage(`✅ Modèle: ${fallback}`, 'success');
                return fallback;
            }

            throw new Error('Aucun modèle Flash disponible');

        } catch (err) {
            console.error('[Model] Erreur détection:', err);
            if (showNotification) showMessage(`⚠️ Utilisation de ${currentModel}`, 'info');
            return currentModel;
        }
    }

    function saveModelToCache(model) {
        currentModel = model;
        GM_setValue('gemini_model_cache', JSON.stringify({
            model: model,
            timestamp: Date.now()
        }));
        GM_setValue('gemini_last_working_model', model);
        updateModelDisplay();
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
                    contents: contents,
                    generationConfig: {
                        maxOutputTokens: CONFIG.MAX_TOKENS,
                        temperature: CONFIG.TEMPERATURE
                    }
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error('[API] Erreur:', response.status, errorBody);

                // Rate limit (429) - NE PAS retry
                if (response.status === 429) {
                    throw new Error('⏳ Trop de requêtes ! Attendez 1 minute avant de réessayer.');
                }

                // Si modèle non trouvé (404) → re-détecter automatiquement
                if (response.status === 404 && retryCount < 1) {
                    console.log('[API] Modèle 404, re-détection...');
                    showMessage('🔄 Modèle obsolète, mise à jour...', 'info', 3000);
                    GM_deleteValue('gemini_model_cache');
                    await detectBestModel(false);
                    return callGeminiAPI(contents, retryCount + 1);
                }

                // Erreur serveur (503) → retry avec même modèle
                if (response.status === 503 && retryCount < 2) {
                    console.log('[API] Erreur 503, retry...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return callGeminiAPI(contents, retryCount + 1);
                }

                throw new Error(`Erreur ${response.status}`);
            }

            // Sauvegarder le modèle qui fonctionne
            GM_setValue('gemini_last_working_model', currentModel);

            return await response.json();

        } catch (err) {
            // Ne pas retry sur rate limit
            if (err.message.includes('Trop de requêtes') || err.message.includes('429')) {
                throw err;
            }
            
            if (retryCount < 2 && !err.message.includes('Erreur')) {
                console.log('[API] Erreur réseau, nouvelle tentative...');
                await new Promise(resolve => setTimeout(resolve, 1000));
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
                position: fixed;
                top: 24px;
                right: 24px;
                padding: 20px 24px;
                border-radius: 22px;
                font-size: 15px;
                font-weight: 500;
                z-index: 10000;
                max-width: 340px;
                box-shadow: 0 16px 48px rgba(0,0,0,0.14);
                backdrop-filter: blur(50px);
                -webkit-backdrop-filter: blur(50px);
                transition: opacity 0.3s, transform 0.3s;
                opacity: 0;
                transform: translateY(-30px) scale(0.9);
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

        setTimeout(() => {
            box.style.opacity = '1';
            box.style.transform = 'translateY(0) scale(1)';
        }, 10);

        setTimeout(() => {
            box.style.opacity = '0';
            box.style.transform = 'translateY(-30px) scale(0.9)';
        }, duration);
    }

    // ============================================
    // CONVERSION FICHIER EN BASE64
    // ============================================
    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // ============================================
    // REMPLISSAGE CRM
    // ============================================
    function fillCrmFields(data) {
        console.log('[CRM] Remplissage:', data);

        const fields = {
            clientType: document.querySelector('select[name="client[type]"]'),
            civility: document.querySelector('select[name="client[title]"]'),
            lastName: document.querySelector('input[name="client[last_name]"]'),
            firstName: document.querySelector('input[name="client[first_name]"]'),
            company: document.querySelector('input[name="client[company]"]'),
            businessName: document.querySelector('input[name="client[business_name]"]'),
            email: document.querySelector('input[name="client[email]"]'),
            email2: document.querySelector('input[name="client[email_2]"]'),
            mobile: document.querySelector('input[name="client[mobile_phone]"]'),
            phone2: document.querySelector('input[name="client[phone_2]"]'),
            address: document.querySelector('input[name="client[address_1]"]'),
            address2: document.querySelector('input[name="client[address_2]"]'),
            zipCode: document.querySelector('input[name="client[postal_code]"]'),
            city: document.querySelector('input[name="client[city]"]'),
            country: document.querySelector('select[name="client[country]"]'),
            birthDate: document.querySelector('input[name="client[birth_date]"]'),
            birthName: document.querySelector('input[name="client[birth_name]"]'),
            website: document.querySelector('input[name="client[website]"]'),
            profession: document.querySelector('input[name="client[profession]"]'),
            siret: document.querySelector('input[name="client[registration_number]"]')
        };

        // TYPE CLIENT
        if (data.clientType && fields.clientType) {
            const typeMap = { 'Individual': '0', 'Company': '1', 'TNS': '2' };
            const typeValue = typeMap[data.clientType] || '0';
            const radioButton = document.querySelector(`input[name="selectItemclient[type]"][value="${typeValue}"]`);
            if (radioButton) {
                radioButton.checked = true;
                radioButton.click();
                showMessage(`Type: ${data.clientType}`, 'info');
            }
        }

        setTimeout(() => {
            // CIVILITÉ
            if (data.civility && (data.clientType === 'Individual' || data.clientType === 'TNS')) {
                setTimeout(() => {
                    const civilityMap = { 'Monsieur': '1', 'Madame': '2', 'Mlle': '3', 'Dr': '6', 'Me': '7' };
                    const civilityValue = civilityMap[data.civility] || '0';
                    if (civilityValue !== '0') {
                        const radioButton = document.querySelector(`input[name="selectItemclient[title]"][value="${civilityValue}"]`);
                        if (radioButton) {
                            radioButton.checked = true;
                            radioButton.click();
                        }
                    }
                }, 300);
            }

            // NOM/PRÉNOM
            if (data.clientType === 'Individual' || data.clientType === 'TNS') {
                if (fields.lastName && data.lastName) {
                    fields.lastName.value = data.lastName;
                    fields.lastName.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (fields.firstName && data.firstName) {
                    fields.firstName.value = data.firstName;
                    fields.firstName.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }

            // SOCIÉTÉ
            if (data.clientType === 'Company' || data.clientType === 'TNS') {
                if (fields.company && data.organization) {
                    fields.company.value = data.organization;
                    fields.company.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (fields.businessName && data.businessName) {
                    fields.businessName.value = data.businessName;
                    fields.businessName.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }

            // EMAILS
            if (fields.email && data.email) {
                fields.email.value = data.email;
                fields.email.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.email2 && data.email2) {
                fields.email2.value = data.email2;
                fields.email2.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // TÉLÉPHONES
            if (fields.mobile && data.mobilePhoneNumber) {
                fields.mobile.value = data.mobilePhoneNumber;
                fields.mobile.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.phone2 && data.professionalPhoneNumber) {
                fields.phone2.value = data.professionalPhoneNumber;
                fields.phone2.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // ADRESSE
            if (fields.address && data.streetAddress) {
                fields.address.value = data.streetAddress;
                fields.address.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.address2 && data.streetAddress2) {
                fields.address2.value = data.streetAddress2;
                fields.address2.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.zipCode && data.zipCode) {
                fields.zipCode.value = data.zipCode;
                fields.zipCode.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.city && data.city) {
                fields.city.value = data.city;
                fields.city.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // DATE ET NOM DE NAISSANCE
            if (fields.birthDate && data.birthDate) {
                fields.birthDate.value = data.birthDate;
                fields.birthDate.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.birthName && data.birthName) {
                fields.birthName.value = data.birthName;
                fields.birthName.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // AUTRES
            if (fields.website && data.website) {
                fields.website.value = data.website;
                fields.website.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (fields.profession && data.jobTitle) {
                fields.profession.value = data.jobTitle;
                fields.profession.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // PAYS
            setTimeout(() => {
                if (fields.country) {
                    const countryValue = (data.country || 'FRANCE').toUpperCase();
                    fields.country.value = countryValue;
                    if (typeof jQuery !== 'undefined') {
                        jQuery(fields.country).trigger('change');
                        try { jQuery(fields.country).multipleSelect('refresh'); } catch(e) {}
                    }
                }
            }, 500);

            // SIRET
            if (data.siret && (data.clientType === 'Company' || data.clientType === 'TNS')) {
                setTimeout(() => {
                    if (fields.siret) {
                        fields.siret.value = data.siret;
                        fields.siret.dispatchEvent(new Event('input', { bubbles: true }));
                        const siretBtn = document.querySelector('span.fa.fa-sync-alt[data-callback="Modulr.Client.Form.ImportCompanyInformation"]');
                        if (siretBtn) {
                            showMessage('🔄 Récupération SIRET...', 'info');
                            setTimeout(() => siretBtn.click(), 800);
                        }
                    }
                }, 1200);
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
            return {
                clientType: (jsonText.match(/"clientType"\s*:\s*"([^"]*)"/) || [])[1] || 'Individual',
                civility: (jsonText.match(/"civility"\s*:\s*"([^"]*)"/) || [])[1] || '',
                firstName: (jsonText.match(/"firstName"\s*:\s*"([^"]*)"/) || [])[1] || '',
                lastName: (jsonText.match(/"lastName"\s*:\s*"([^"]*)"/) || [])[1] || '',
                email: (jsonText.match(/"email"\s*:\s*"([^"]*)"/) || [])[1] || '',
                email2: (jsonText.match(/"email2"\s*:\s*"([^"]*)"/) || [])[1] || '',
                mobilePhoneNumber: (jsonText.match(/"mobilePhoneNumber"\s*:\s*"([^"]*)"/) || [])[1] || '',
                professionalPhoneNumber: (jsonText.match(/"professionalPhoneNumber"\s*:\s*"([^"]*)"/) || [])[1] || '',
                streetAddress: (jsonText.match(/"streetAddress"\s*:\s*"([^"]*)"/) || [])[1] || '',
                streetAddress2: (jsonText.match(/"streetAddress2"\s*:\s*"([^"]*)"/) || [])[1] || '',
                zipCode: (jsonText.match(/"zipCode"\s*:\s*"([^"]*)"/) || [])[1] || '',
                city: (jsonText.match(/"city"\s*:\s*"([^"]*)"/) || [])[1] || '',
                country: (jsonText.match(/"country"\s*:\s*"([^"]*)"/) || [])[1] || 'FRANCE',
                organization: (jsonText.match(/"organization"\s*:\s*"([^"]*)"/) || [])[1] || '',
                businessName: (jsonText.match(/"businessName"\s*:\s*"([^"]*)"/) || [])[1] || '',
                siret: (jsonText.match(/"siret"\s*:\s*"([^"]*)"/) || [])[1] || '',
                birthDate: (jsonText.match(/"birthDate"\s*:\s*"([^"]*)"/) || [])[1] || '',
                birthName: (jsonText.match(/"birthName"\s*:\s*"([^"]*)"/) || [])[1] || '',
                jobTitle: (jsonText.match(/"jobTitle"\s*:\s*"([^"]*)"/) || [])[1] || '',
                website: (jsonText.match(/"website"\s*:\s*"([^"]*)"/) || [])[1] || ''
            };
        }
    }

    // ============================================
    // PROMPT SELON TYPE DE DOCUMENT
    // ============================================
    function getPromptForDocument(docType) {
        const basePrompt = `Analyse ce document et extrait les informations. Réponds UNIQUEMENT en JSON valide sans markdown.`;

        const prompts = {
            'cni': `${basePrompt}
Document: CARTE NATIONALE D'IDENTITÉ française
Extrais: nom, prénom, date de naissance (format DD/MM/YYYY), sexe (pour civilité), lieu de naissance, adresse si visible.
- clientType = "Individual"
- civility = "Monsieur" si sexe M, "Madame" si sexe F
- birthName = nom de naissance si différent du nom d'usage`,

            'permis': `${basePrompt}
Document: PERMIS DE CONDUIRE français
Extrais: nom, prénom, date de naissance (format DD/MM/YYYY), adresse complète.
- clientType = "Individual"
- Déduis civility du prénom`,

            'passeport': `${basePrompt}
Document: PASSEPORT
Extrais: nom, prénom, date de naissance (format DD/MM/YYYY), sexe, lieu de naissance, nationalité.
- clientType = "Individual"
- civility = "Monsieur" si sexe M, "Madame" si sexe F`,

            'kbis': `${basePrompt}
Document: EXTRAIT KBIS / K-BIS
Extrais: dénomination sociale, SIRET (14 chiffres), SIREN (9 chiffres), adresse du siège, forme juridique, nom du dirigeant/gérant.
- Si forme juridique contient "EURL", "SASU", "auto-entrepreneur", "EI" → clientType = "TNS", extrais nom/prénom du dirigeant
- Sinon → clientType = "Company"
- organization = dénomination sociale
- firstName/lastName = dirigeant (pour TNS)`,

            'rib': `${basePrompt}
Document: RIB / Relevé d'Identité Bancaire
Extrais: nom du titulaire, adresse si visible.
- clientType = "Individual" sauf si nom de société visible`,

            'facture': `${basePrompt}
Document: FACTURE
Extrais: nom/raison sociale du client, adresse complète, SIRET si visible, email, téléphone.
- Si SIRET présent → clientType = "Company" ou "TNS"
- Sinon → clientType = "Individual"`,

            'auto': `${basePrompt}
Document: TYPE INCONNU - Analyse automatique
Identifie le type de document (CNI, permis, passeport, KBIS, facture, courrier...) et extrait toutes les informations pertinentes:
- Pour un particulier: nom, prénom, date naissance, adresse, téléphone, email
- Pour une entreprise: raison sociale, SIRET, adresse siège, dirigeant
- Déduis clientType: "Individual", "Company" ou "TNS"
- Déduis civility du prénom ou du sexe`
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

        showMessage(`📄 Analyse de ${file.name}...`, 'info', 10000);
        setButtonsDisabled(true);

        try {
            const base64Data = await fileToBase64(file);
            console.log('[OCR] Base64 généré, taille:', base64Data.length);

            const prompt = getPromptForDocument(docType) + `

JSON attendu:
{"clientType":"","civility":"","firstName":"","lastName":"","email":"","email2":"","mobilePhoneNumber":"","professionalPhoneNumber":"","streetAddress":"","streetAddress2":"","zipCode":"","city":"","country":"FRANCE","jobTitle":"","organization":"","businessName":"","birthDate":"","birthName":"","siret":"","website":""}`;

            let mimeType = file.type;
            if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

            const contents = [{
                role: "user",
                parts: [
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: base64Data
                        }
                    },
                    { text: prompt }
                ]
            }];

            console.log('[OCR] Envoi à Gemini (modèle:', currentModel, ')...');
            const result = await callGeminiAPI(contents);

            if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
                if (result.promptFeedback?.blockReason) {
                    throw new Error(`Contenu bloqué: ${result.promptFeedback.blockReason}`);
                }
                throw new Error('Réponse vide de Gemini');
            }

            const jsonText = result.candidates[0].content.parts[0].text;
            console.log('[OCR] Texte reçu:', jsonText);

            const data = parseJsonRobust(jsonText);
            console.log('[OCR] Données extraites:', data);

            if (!data.country) data.country = 'FRANCE';

            fillCrmFields(data);
            showMessage(`✅ Document analysé !`, 'success');

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

        showMessage("🤖 Extraction en cours...", 'info');
        setButtonsDisabled(true);

        try {
            const prompt = `Extrait les données client. Règles:
- TNS dans texte → clientType="TNS" + extrais nom/prénom du gérant
- SIRET 14 chiffres → clientType="Company"
- Sinon → clientType="Individual"
- Déduis civilité du prénom (Monsieur/Madame/Dr/Me)
- country="FRANCE" par défaut

Texte: ${text}

JSON uniquement:
{"clientType":"","civility":"","firstName":"","lastName":"","email":"","email2":"","mobilePhoneNumber":"","professionalPhoneNumber":"","streetAddress":"","streetAddress2":"","zipCode":"","city":"","country":"FRANCE","jobTitle":"","organization":"","businessName":"","birthDate":"","birthName":"","siret":"","website":""}`;

            const contents = [{ role: "user", parts: [{ text: prompt }] }];

            const result = await callGeminiAPI(contents);

            if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('Réponse vide');
            }

            const data = parseJsonRobust(result.candidates[0].content.parts[0].text);
            if (!data.country) data.country = 'FRANCE';

            if (!data.siret) {
                const siretMatch = text.match(/\b\d{14}\b/);
                if (siretMatch) data.siret = siretMatch[0];
            }

            fillCrmFields(data);
            showMessage(`✅ Extraction réussie !`, 'success');

        } catch (err) {
            console.error('[IA] Erreur:', err);
            showMessage(`❌ ${err.message}`, 'error');
        } finally {
            setButtonsDisabled(false);
        }
    }

    // ============================================
    // UTILITAIRES UI
    // ============================================
    function setButtonsDisabled(disabled) {
        document.querySelectorAll('.ai-btn-primary, .ai-btn-file').forEach(btn => {
            btn.disabled = disabled;
        });
    }

    // ============================================
    // TEST API
    // ============================================
    async function testApi() {
        showMessage("🔍 Test connexion...", 'info');
        try {
            const result = await callGeminiAPI([{ role: "user", parts: [{ text: "Réponds OK" }] }]);
            if (result.candidates) {
                showMessage(`✅ API OK ! Modèle: ${currentModel}`, 'success');
            } else {
                showMessage(`❌ Réponse invalide`, 'error');
            }
        } catch (err) {
            showMessage(`❌ ${err.message}`, 'error');
        }
    }

    // Forcer la re-détection du modèle (clic manuel)
    async function refreshModel() {
        GM_deleteValue('gemini_model_cache');
        await detectBestModel(true);
        updateModelDisplay();
    }

    function updateModelDisplay() {
        const modelInfo = document.querySelector('.ai-model-info');
        if (modelInfo) {
            modelInfo.textContent = `Modèle: ${currentModel}`;
        }
    }

    // ============================================
    // INTERFACE
    // ============================================
    function initUI() {
        // Charger le modèle depuis le cache (ZÉRO appel API)
        loadModelFromCache();

        const style = document.createElement('style');
        style.textContent = `
            .ai-container {
                position: fixed;
                top: 10px;
                right: 10px;
                width: 460px;
                border-radius: 36px;
                z-index: 9999;
                box-shadow: 0 24px 64px -16px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(255,255,255,0.9);
                backdrop-filter: blur(60px) saturate(220%);
                -webkit-backdrop-filter: blur(60px) saturate(220%);
                background: linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0.85) 100%);
                border: 1px solid rgba(255,255,255,0.95);
                animation: slideIn 0.8s cubic-bezier(0.16,1,0.3,1);
                font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
            }
            .ai-container.minimized { display: none; }
            @keyframes slideIn {
                from { opacity: 0; transform: translateY(30px) scale(0.94); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            .ai-header {
                padding: 28px 28px 24px;
                background: linear-gradient(180deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.05) 100%);
                border-bottom: 0.5px solid rgba(0,0,0,0.05);
                border-radius: 36px 36px 0 0;
                position: relative;
            }
            .ai-minimize {
                position: absolute; top: 28px; right: 28px;
                width: 32px; height: 32px; border: none; border-radius: 50%;
                background: rgba(0,0,0,0.05); color: rgba(0,0,0,0.5);
                font-size: 16px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
            }
            .ai-minimize:hover { background: rgba(0,0,0,0.1); }
            .ai-title {
                font-size: 24px; font-weight: 600;
                background: linear-gradient(135deg, #2c2c2e 0%, #48484a 100%);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                margin: 0 0 6px 0;
            }
            .ai-subtitle { font-size: 13px; color: rgba(0,0,0,0.45); margin: 0; }
            .ai-status {
                display: inline-flex; align-items: center; gap: 8px;
                padding: 8px 14px; border-radius: 100px;
                background: rgba(52,199,89,0.12); font-size: 12px;
                color: #34C759; margin-top: 12px;
            }
            .ai-status-dot {
                width: 6px; height: 6px; border-radius: 50%;
                background: #34C759; animation: pulse 2s ease-in-out infinite;
            }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

            .ai-content { padding: 24px 28px 28px; }

            /* TABS */
            .ai-tabs {
                display: flex; gap: 8px; margin-bottom: 20px;
            }
            .ai-tab {
                flex: 1; padding: 12px; border: none; border-radius: 12px;
                background: rgba(0,0,0,0.04); color: rgba(0,0,0,0.6);
                font-size: 13px; font-weight: 500; cursor: pointer;
                transition: all 0.2s;
            }
            .ai-tab:hover { background: rgba(0,0,0,0.08); }
            .ai-tab.active {
                background: linear-gradient(180deg, #007AFF 0%, #0051D5 100%);
                color: #fff;
            }

            .ai-panel { display: none; }
            .ai-panel.active { display: block; }

            .ai-label {
                display: block; font-size: 13px; font-weight: 500;
                color: rgba(0,0,0,0.6); margin-bottom: 10px;
            }
            .ai-textarea {
                width: 100%; height: 160px; padding: 16px;
                border: none; border-radius: 16px;
                background: rgba(248,248,248,0.8); color: #1d1d1f;
                font-size: 14px; resize: vertical; box-sizing: border-box;
                margin-bottom: 16px;
            }
            .ai-textarea:focus {
                outline: none; background: #fff;
                box-shadow: 0 0 0 2px rgba(0,122,255,0.3);
            }

            /* FILE UPLOAD */
            .ai-file-zone {
                border: 2px dashed rgba(0,0,0,0.15); border-radius: 16px;
                padding: 30px 20px; text-align: center;
                margin-bottom: 16px; cursor: pointer;
                transition: all 0.3s;
            }
            .ai-file-zone:hover, .ai-file-zone.dragover {
                border-color: #007AFF; background: rgba(0,122,255,0.05);
            }
            .ai-file-zone-icon { font-size: 36px; margin-bottom: 10px; }
            .ai-file-zone-text { font-size: 14px; color: rgba(0,0,0,0.6); margin-bottom: 6px; }
            .ai-file-zone-hint { font-size: 11px; color: rgba(0,0,0,0.4); }
            .ai-file-input { display: none; }

            .ai-file-preview {
                display: none; padding: 12px; border-radius: 12px;
                background: rgba(52,199,89,0.1); margin-bottom: 16px;
                font-size: 13px; color: #34C759;
            }
            .ai-file-preview.visible { display: flex; align-items: center; gap: 10px; }
            .ai-file-preview-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
            .ai-file-preview-remove {
                background: none; border: none; color: #FF3B30;
                cursor: pointer; font-size: 16px;
            }

            /* DOC TYPE SELECT */
            .ai-select {
                width: 100%; padding: 14px 16px; border: none;
                border-radius: 12px; background: rgba(0,0,0,0.04);
                font-size: 14px; margin-bottom: 16px; cursor: pointer;
                appearance: none; -webkit-appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 14px center;
                line-height: 1.4;
            }
            .ai-select:focus { outline: none; box-shadow: 0 0 0 2px rgba(0,122,255,0.3); }

            /* BUTTONS */
            .ai-btn-primary, .ai-btn-file {
                width: 100%; padding: 16px; border: none; border-radius: 16px;
                background: linear-gradient(180deg, #007AFF 0%, #0051D5 100%);
                color: #fff; font-size: 15px; font-weight: 600;
                cursor: pointer; margin-bottom: 12px;
                box-shadow: 0 4px 16px rgba(0,122,255,0.3);
                transition: all 0.3s;
            }
            .ai-btn-primary:hover, .ai-btn-file:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 24px rgba(0,122,255,0.4);
            }
            .ai-btn-primary:disabled, .ai-btn-file:disabled {
                opacity: 0.5; cursor: not-allowed; transform: none;
            }
            .ai-btn-file {
                background: linear-gradient(180deg, #34C759 0%, #28A745 100%);
                box-shadow: 0 4px 16px rgba(52,199,89,0.3);
            }
            .ai-btn-file:hover {
                box-shadow: 0 8px 24px rgba(52,199,89,0.4);
            }

            .ai-btn-secondary {
                flex: 1; padding: 12px; border: none; border-radius: 12px;
                background: rgba(0,0,0,0.04); color: rgba(0,0,0,0.6);
                font-size: 13px; cursor: pointer;
            }
            .ai-btn-secondary:hover { background: rgba(0,0,0,0.08); }

            .ai-footer {
                display: flex; gap: 8px; margin-top: 8px;
            }

            .ai-model-info {
                font-size: 11px; color: rgba(0,0,0,0.35);
                text-align: center; margin-top: 12px;
                cursor: pointer;
            }
            .ai-model-info:hover {
                color: rgba(0,0,0,0.6);
                text-decoration: underline;
            }

            .ai-fab {
                position: fixed; bottom: 90px; right: 24px;
                width: 60px; height: 60px; border: none; border-radius: 50%;
                background: linear-gradient(180deg, #007AFF 0%, #0051D5 100%);
                color: #fff; font-size: 24px; cursor: pointer;
                display: none; align-items: center; justify-content: center;
                z-index: 9998;
                box-shadow: 0 8px 24px rgba(0,122,255,0.35);
            }
            .ai-fab.visible { display: flex; }
            .ai-fab:hover { transform: scale(1.1); }
        `;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.className = 'ai-container';
        container.innerHTML = `
            <div class="ai-header">
                <button class="ai-minimize">−</button>
                <h2 class="ai-title">Remplissage Auto</h2>
                <p class="ai-subtitle">IA + OCR Documents · V9.2.3</p>
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

                <!-- PANEL TEXTE -->
                <div id="panel-text" class="ai-panel active">
                    <label class="ai-label">Collez le texte client</label>
                    <textarea id="ai-input" class="ai-textarea" placeholder="Collez ici les informations du client (email, signature, fiche...)"></textarea>
                    <button id="extract-text-btn" class="ai-btn-primary">✨ Extraire et remplir</button>
                </div>

                <!-- PANEL FICHIER -->
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
                    <button id="test-api" class="ai-btn-secondary">🔍 Test</button>
                    <button id="refresh-model" class="ai-btn-secondary">🔄 Modèle</button>
                    <button id="reset-key" class="ai-btn-secondary">🔑 Clé</button>
                </div>
                <p class="ai-model-info" title="Cliquez pour actualiser">${currentModel}</p>
            </div>
        `;
        document.body.prepend(container);

        // FAB
        const fab = document.createElement('button');
        fab.className = 'ai-fab';
        fab.innerHTML = '✨';
        document.body.appendChild(fab);

        // === EVENTS ===

        // Minimize
        container.querySelector('.ai-minimize').onclick = () => {
            container.classList.add('minimized');
            fab.classList.add('visible');
        };
        fab.onclick = () => {
            container.classList.remove('minimized');
            fab.classList.remove('visible');
        };

        // Tabs
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

        fileInput.onchange = () => {
            if (fileInput.files.length) handleFileSelect(fileInput.files[0]);
        };

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
            if (selectedFile) {
                const docType = document.getElementById('doc-type').value;
                extractFromFile(selectedFile, docType);
            }
        };

        // Text extraction
        document.getElementById('extract-text-btn').onclick = () => {
            extractFromText(document.getElementById('ai-input').value);
        };

        // Utilities
        document.getElementById('test-api').onclick = testApi;
        document.getElementById('refresh-model').onclick = refreshModel;
        document.getElementById('reset-key').onclick = () => {
            if (confirm('Supprimer la clé API ?')) {
                GM_deleteValue('gemini_api_key');
                GM_deleteValue('gemini_model_cache');
                GM_deleteValue('gemini_last_working_model');
                location.reload();
            }
        };

        // Clic sur le modèle pour rafraîchir
        document.querySelector('.ai-model-info').onclick = refreshModel;
    }

    window.addEventListener('load', initUI);
})();
