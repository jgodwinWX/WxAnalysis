# Wx Mesoanalysis Dashboard

A prototype web-based mesoanalysis dashboard for visualizing surface observations, station plots, and objective analysis fields (e.g., isotherms, isodrosotherms, and isobars).

The application consists of a **Python (FastAPI) backend** and a **JavaScript frontend**.

---

## Project Structure

```
project-root/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── ...
└── frontend/
    ├── package.json
    ├── src/
    └── ...
```

---

## Prerequisites

- Python 3.9 or newer  
- Node.js 18 or newer (Node 20 recommended)  
- npm (included with Node.js)  
- A Python virtual environment (venv, conda, etc.)

---

## Backend Setup (FastAPI)

1. Open a terminal and navigate to the backend directory:

   ```bash
   cd backend
   ```

2. Activate the Python environment you want to use.

   Example (venv):
   ```bash
   source venv/bin/activate
   ```

   Example (conda):
   ```bash
   conda activate your-env-name
   ```

3. Install backend dependencies:

   ```bash
   pip install -r requirements.txt
   ```

4. Start the FastAPI development server:

   ```bash
   uvicorn main:app --reload --port 8000
   ```

5. The backend API will be available at:

   ```
   http://localhost:8000
   ```

---

## Frontend Setup

1. Open a second terminal and navigate to the frontend directory:

   ```bash
   cd frontend
   ```

2. Install frontend dependencies:

   ```bash
   npm install
   ```

3. Start the frontend development server:

   ```bash
   npm run dev
   ```

4. The frontend will typically be available at:

   ```
   http://localhost:5173
   ```

   (The exact port may vary depending on your setup.)

---

## Running the Application

1. Ensure the backend is running on port 8000.
2. Ensure the frontend dev server is running.
3. Open the frontend URL in your browser.
4. The frontend will communicate with the backend API to retrieve surface observation data and render the mesoanalysis visualizations.

---

## Notes

- This project is a prototype and intended for development and experimentation.
- The `--reload` flag in uvicorn enables automatic reloading when backend code changes.
- Frontend hot module reloading (HMR) is enabled by default when running `npm run dev`.

---

## License

MIT
