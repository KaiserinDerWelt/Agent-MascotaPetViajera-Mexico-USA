# 🐶 Justino · Agente MascotaPet Viajera México ↔ USA

<p align="center">
  <img src="MascotaPet.JPG" alt="Justino MascotaPet" width="400"/>
</p>

<p align="center">
  <a href="https://agent-mascota-pet-viajera-mexico-us.vercel.app/"><b>🌐 Probar a Justino / Try Justino</b></a>
  ·
  <a href="CURRENT.md">📘 Documentación técnica / Technical docs</a>
</p>

Proyecto de hackathon del curso **META · Gen 1, DEV.F - CPFIA (Gobierno de México)**.
Hackathon project for the **META · Gen 1 and DEV.F - CPFIA (Mexican Government)** course.

[Español](#español) · [English](#english)

---

# Español

## 📌 ¿Qué es Justino?
**Justino** es un perrito agente conversacional que guía a las personas en los trámites y requisitos para **viajar con perros entre México y Estados Unidos** (importación y exportación), con base en la normativa vigente de **SENASICA**.

👉 **Demo en línea:** https://agent-mascota-pet-viajera-mexico-us.vercel.app/

## 🎯 Motivación
La idea surge de mi experiencia personal al transportar a mi perrita y enfrentar dificultades para acceder a la información oficial. Hoy los requisitos se consultan en la página de SENASICA o se solicitan por correo electrónico, y después se recibe un PDF con la normativa.

## 🚨 Problema
- Usuarios frustrados por la falta de claridad.
- Gran parte del contenido está en **imágenes no indexadas en Google**.
- Errores de último momento al importar o exportar mascotas.
- Lenguaje **técnico y poco claro** para personas sin conocimientos aduanales o veterinarios.
- Servicios gratuitos encarecidos por gestores que cobran miles de pesos por trámites e información.

## 💡 Solución
Justino responde en español de México, de forma breve y clara, usando **solo** la información de los documentos oficiales cargados:
- Explica los requisitos de forma accesible.
- Centraliza la información en un solo lugar.
- Reduce costos y errores en el proceso.

## ⚙️ ¿Cómo funciona?
Justino usa **RAG (Retrieval-Augmented Generation)**:
1. Los PDF de SENASICA se dividen en fragmentos y se guardan en **Supabase** (pgvector) junto con su *embedding*.
2. Cuando escribes una pregunta, se convierte en un *embedding* con **Hugging Face** (`all-MiniLM-L6-v2`).
3. Se buscan los fragmentos más parecidos en Supabase.
4. Un modelo de lenguaje de **Hugging Face** redacta la respuesta usando solo esos fragmentos. Si el modelo no está disponible, Justino responde con el texto de los documentos.

**Tecnologías:** React 19 · TypeScript · Vite · Material UI · Hugging Face Inference · Supabase (pgvector) · Vercel.

## 🚀 Ejecutarlo localmente
```bash
cd AgentJustino
npm install
# crea AgentJustino/.env con tus llaves (ver CURRENT.md)
npm run dev
```
Abre http://localhost:5173/. La guía completa de configuración, la base de datos y el despliegue está en **[CURRENT.md](CURRENT.md)**.

## 🌍 Escalabilidad
Aunque hoy el enfoque es **México ↔ USA**, el proyecto es **escalable a decenas de países** para los que SENASICA emite certificados de importación y exportación de mascotas vía aérea.

## ✨ Objetivo final
Facilitar el transporte internacional de **perritos y gatitos** 🐾, eliminando barreras de acceso a la información y ofreciendo una experiencia más amigable para los dueños de mascotas.

## 🐾 Dedicado a mi amigo que se fue

<p align="center">❤️🐾❤️🐾❤️🐾❤️🐾❤️</p>

**En honor de mi mejor amigo y compañero de viaje, mi pug: el Justin, por todos los viajes que hicimos entre México y USA durante 10 años. QEPD**

<p align="center">❤️🐾❤️🐾❤️🐾❤️🐾❤️</p>

---

# English

## 📌 What is Justino?
**Justino** is a conversational dog agent that guides people through the **procedures and requirements for traveling with dogs between Mexico and the USA** (import and export), based on current **SENASICA** regulations.

👉 **Live demo:** https://agent-mascota-pet-viajera-mexico-us.vercel.app/

## 🎯 Motivation
The idea came from my own experience transporting my dog and struggling to access official information. Today, requirements must be checked on SENASICA's website or requested by email, after which you receive a PDF with the regulations.

## 🚨 Problem
- Users are frustrated by the lack of clarity.
- Much of the content is embedded in **images that Google does not index**.
- Last-minute mistakes happen when importing or exporting pets.
- The language is **technical and unclear** for people without customs or veterinary knowledge.
- Free services become expensive because intermediaries charge thousands of pesos for information and paperwork.

## 💡 Solution
Justino answers in Mexican Spanish, briefly and clearly, using **only** the information in the official documents that were loaded:
- Explains requirements in plain language.
- Centralizes the information in one place.
- Reduces costs and errors in the process.

## ⚙️ How it works
Justino uses **RAG (Retrieval-Augmented Generation)**:
1. SENASICA PDFs are split into chunks and stored in **Supabase** (pgvector) along with their embeddings.
2. Your question is turned into an embedding with **Hugging Face** (`all-MiniLM-L6-v2`).
3. Supabase returns the most similar chunks.
4. A **Hugging Face** language model writes the answer using only those chunks. If the model is unavailable, Justino answers with text from the documents instead.

**Stack:** React 19 · TypeScript · Vite · Material UI · Hugging Face Inference · Supabase (pgvector) · Vercel.

## 🚀 Run it locally
```bash
cd AgentJustino
npm install
# create AgentJustino/.env with your keys (see CURRENT.md)
npm run dev
```
Open http://localhost:5173/. The full setup, database and deployment guide is in **[CURRENT.md](CURRENT.md)**.

## 🌍 Scalability
While the current focus is **Mexico ↔ USA**, the project can **scale to dozens of countries** for which SENASICA issues import and export certificates for pets traveling by air.

## ✨ Final goal
To make international travel easier for **dogs and cats** 🐾 by removing barriers to information and offering a friendlier experience for pet owners.

## 🐾 Dedication

<p align="center">❤️🐾❤️🐾❤️🐾❤️🐾❤️</p>

**In honor of my best friend and travel companion, my pug Justin, for all the journeys we made between Mexico and the USA over 10 years. RIP**

<p align="center">❤️🐾❤️🐾❤️🐾❤️🐾❤️</p>
