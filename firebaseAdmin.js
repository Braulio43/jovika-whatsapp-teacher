// firebaseAdmin.js
import admin from "firebase-admin";
import fs from "node:fs";

// Caminho do ficheiro de credenciais
// Local: ./serviceAccountKey.json
// No Render: FIREBASE_KEY_PATH aponta para o Secret File
const serviceAccountPath =
  process.env.FIREBASE_KEY_PATH || "./serviceAccountKey.json";

let db = null;

if (!admin.apps.length) {
  if (!fs.existsSync(serviceAccountPath)) {
    console.error("❌ Firebase: ficheiro serviceAccountKey.json não encontrado:", serviceAccountPath);
  } else {
    const serviceAccount = JSON.parse(
      fs.readFileSync(serviceAccountPath, "utf8")
    );

    // Inicializar Firebase Admin
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    console.log("✅ Firebase Admin inicializado com sucesso");
  }
}

// Coleção principal de alunos
const studentsCollection = db ? db.collection("students") : null;

/**
 * Guarda/atualiza os dados do aluno no Firestore
 * docId = whatsapp:+351...
 */
export async function saveStudentToFirestore(phone, aluno) {
  try {
    if (!db || !studentsCollection) {
      console.warn("⚠️ Firebase ainda não inicializado — skip save");
      return;
    }

    const docId = `whatsapp:+${phone}`;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const payload = {
      nome: aluno.nome || null,
      idioma: aluno.idioma || null,
      nivel: aluno.nivel || null,
      stage: aluno.stage || null,
      messagesCount: aluno.messagesCount || 0,
      moduleIndex: aluno.moduleIndex ?? 0,
      moduleStep: aluno.moduleStep ?? 0,
      lastMessageAt: now,
    };

    // Apenas define createdAt uma vez
    if (!aluno._firestoreCreated) {
      payload.createdAt = now;
      aluno._firestoreCreated = true;
    }

    await studentsCollection.doc(docId).set(payload, { merge: true });
    console.log("💾 Aluno guardado no Firestore:", docId);

  } catch (err) {
    console.error(
      "❌ Erro ao guardar aluno no Firestore:",
      err.response?.data || err.message
    );
  }
}

// 🔥 Exportamos db para poder usar no dashboard
export { db, studentsCollection };
