/* global __app_id __firebase_config __initial_auth_token */import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, collection, query, onSnapshot, updateDoc, deleteDoc, addDoc, serverTimestamp } from 'firebase/firestore';

// ====================================================================================
// --- CONFIGURATION SETUP (ACTION REQUIRED FOR DEPLOYMENT) ---
// 
// When you deploy this app externally (e.g., Netlify/Vercel), you MUST replace 
// the two placeholder lines below with your actual, private Firebase keys.
// DO NOT PASTE THESE KEYS IN THE CHAT FOR SECURITY.
// ====================================================================================

// PASTE THIS FINAL BLOCK HERE:

// 1. Define the final configuration object using the secure Netlify variables
const firebaseConfig = process.env.REACT_APP_FIREBASE_CONFIG
  ? JSON.parse(process.env.REACT_APP_FIREBASE_CONFIG)
  : null;

// 2. Define the variables the rest of your app needs:
const appId = process.env.REACT_APP_APP_ID;
const initialAuthToken = process.env.REACT_APP_INITIAL_AUTH_TOKEN;

// 3. Initialize Firebase services once
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// The following lines MUST be replaced with your own keys when you deploy externally.
// Replace {} with your full Firebase configuration object { apiKey: "...", authDomain: "...", etc. }
const hardcodedFirebaseConfig = {apiKey: "AIzaSyAZY4-1fy8AighnzuCvmVQh8tQIiEMJMbo",
  authDomain: "amen-bar-and-restaurant-e70ae.firebaseapp.com",
  projectId: "amen-bar-and-restaurant-e70ae",
  storageBucket: "amen-bar-and-restaurant-e70ae.firebasestorage.app",
  messagingSenderId: "501422459243",
  appId: "1:501422459243:web:36143eca6544dd8fa3a42e",
  measurementId: "G-6LF6ZPSLM3"}; 
// Keep this as null for external, simple deployment




// API Configuration
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=`;

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

// Initialize Firebase (outside component for singleton)
const app = Object.keys(firebaseConfig).length ? initializeApp(firebaseConfig) : null;
const db = app ? getFirestore(app) : null;
const auth = app ? getAuth(app) : null;

// Utility functions
const formatCurrency = (amount) => {
  if (isNaN(amount) || amount === null) return 'ETB 0.00';
  return `ETB ${parseFloat(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
};

const formatDate = (timestamp) => {
  if (!timestamp) return 'N/A';
  if (timestamp.toDate) {
    return timestamp.toDate().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// --- API CALL FUNCTION with exponential backoff ---
const callGeminiApi = async (systemInstruction, userQuery, maxRetries = MAX_RETRIES) => {
  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    tools: [{ "google_search": {} }], // Optional: for grounding
    systemInstruction: { parts: [{ text: systemInstruction }] },
  };

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 429 && i < maxRetries - 1) {
        const delay = INITIAL_BACKOFF_MS * (2 ** i) + Math.random() * INITIAL_BACKOFF_MS;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const result = await response.json();
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "No analysis generated.";
      return text;
    } catch (error) {
      if (i === maxRetries - 1) {
        console.error("Gemini API failed after all retries:", error);
        return "Error: Could not connect to Supply Chain Analyst. Please check your network.";
      }
    }
  }
};


// --- APP COMPONENT ---
const App = () => {
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAnalysisModalOpen, setIsAnalysisModalOpen] = useState(false);
  const [analysisResult, setAnalysisResult] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentItem, setCurrentItem] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterLowStock, setFilterLowStock] = useState(false);

  // 1. Authentication and Initialization
  useEffect(() => {
    if (!auth || !db) {
      console.error("Firebase not initialized.");
      return;
    }

    // Set up Auth State Listener
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        // Sign in anonymously if no user is present
        try {
          if (initialAuthToken) {
            const userCredential = await signInWithCustomToken(auth, initialAuthToken);
            setUserId(userCredential.user.uid);
          } else {
            const userCredential = await signInAnonymously(auth);
            setUserId(userCredential.user.uid);
          }
        } catch (error) {
          console.error("Auth error:", error);
          setUserId(crypto.randomUUID()); // Fallback to a random ID if auth fails
        }
      }
      setIsAuthReady(true);
    });

    return () => unsubscribe();
  }, []);

  // 2. Data Fetching (Firestore onSnapshot)
  useEffect(() => {
    if (db && userId) {
      setLoading(true);
      // NOTE: This collection path uses the security rule structure for private user data
      const inventoryRef = collection(db, `/artifacts/${appId}/users/${userId}/inventory`);
      const q = query(inventoryRef);

      const unsubscribe = onSnapshot(q, (snapshot) => {
        const items = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
        }));
        setInventory(items);
        setLoading(false);
      }, (error) => {
        console.error("Error fetching inventory: ", error);
        setLoading(false);
      });

      return () => unsubscribe();
    }
  }, [ userId]);

  // --- Inventory Operations ---

  const handleSaveItem = async (data) => {
    if (!userId) {
      console.error("Error: User not authenticated. Cannot save data.");
      return;
    }

    const { name, stock, reorderLevel, unit, cost, vendor, vendorContact } = data;
    const inventoryRef = collection(db, `/artifacts/${appId}/users/${userId}/inventory`);

    // Preserve existing order status if editing
    const isNowOrdered = currentItem?.isOrdered || false;
    const currentExpectedDelivery = currentItem?.expectedDelivery || null;


    const itemData = {
      name: name.trim(),
      currentStock: parseFloat(stock),
      reorderLevel: parseFloat(reorderLevel),
      unit: unit,
      unitCost: parseFloat(cost),
      primaryVendor: vendor,
      vendorContact: vendorContact,
      createdAt: currentItem ? currentItem.createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
      isOrdered: isNowOrdered,
      expectedDelivery: currentExpectedDelivery,
    };

    try {
      if (currentItem && currentItem.id) {
        const docRef = doc(db, inventoryRef.path, currentItem.id);
        await updateDoc(docRef, itemData);
      } else {
        await addDoc(inventoryRef, itemData);
      }
      setIsModalOpen(false);
      setCurrentItem(null);
    } catch (e) {
      console.error("Error saving document: ", e);
    }
  };


  const handleDeleteItem = async (id) => {
    if (!userId) return;
    try {
      const docRef = doc(db, `/artifacts/${appId}/users/${userId}/inventory`, id);
      await deleteDoc(docRef);
    } catch (e) {
      console.error("Error deleting document: ", e);
    }
  };

  

  const handleMarkAsOrdered = async (item, deliveryDate) => {
    if (!userId) return;
    try {
      const docRef = doc(db, `/artifacts/${appId}/users/${userId}/inventory`, item.id);
      await updateDoc(docRef, {
        isOrdered: true,
        expectedDelivery: new Date(deliveryDate),
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("Error marking as ordered: ", e);
    }
  };


  // --- AI Analysis Logic ---

  const handleGenerateAnalysis = async () => {
    setIsAnalyzing(true);
    setAnalysisResult('');
    setIsAnalysisModalOpen(true);

    const urgentItems = inventory.filter(item =>
      item.currentStock <= item.reorderLevel && !item.isOrdered
    );

    if (urgentItems.length === 0) {
      setAnalysisResult("All critical items are either well-stocked or an order has already been placed. No immediate ordering action is required.");
      setIsAnalyzing(false);
      return;
    }

    const itemDetails = urgentItems.map(item => ({
      name: item.name,
      currentStock: `${item.currentStock} ${item.unit}`,
      reorderLevel: `${item.reorderLevel} ${item.unit}`,
      unitCost: item.unitCost,
      totalStockValue: item.currentStock * item.unitCost,
      vendor: item.primaryVendor,
      vendorContact: item.vendorContact,
    }));

    const systemPrompt = `You are the Amen Bar and Restaurant Supply Chain Analyst. Your goal is to provide a concise, actionable reordering plan based on the provided low-stock items.

    Instructions:
    1. Analyze the 'currentStock' relative to the 'reorderLevel' and the 'unitCost' (in ETB) for financial risk.
    2. Suggest a specific order quantity (in the item's unit) that brings the stock back up, considering a safety margin (e.g., order enough for 1.5 times the reorder level).
    3. PRIORITIZE the most financially impactful or urgently needed items first.
    4. Provide the vendor contact information for each recommended item.
    5. The response MUST be a single, professional paragraph. Do not use bullet points or lists.
    `;

    const userQuery = `Analyze the following urgent inventory items and provide a reordering plan for Amen Bar and Restaurant.

    Inventory Data (ETB, Kilograms, Liters):
    ${JSON.stringify(itemDetails, null, 2)}
    `;

    const result = await callGeminiApi(systemPrompt, userQuery);
    setAnalysisResult(result);
    setIsAnalyzing(false);
  };

  // --- Filtering and Memoization ---

  const filteredInventory = useMemo(() => {
    let list = inventory;

    // 1. Search Filter
    if (searchTerm) {
      list = list.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.primaryVendor.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // 2. Low Stock Filter (for the checkbox)
    if (filterLowStock) {
      list = list.filter(item => item.currentStock <= item.reorderLevel && !item.isOrdered);
    }

    // 3. Sort by Status (Urgent first, then Ordered, then Normal)
    list.sort((a, b) => {
      const statusA = (a.currentStock <= a.reorderLevel && !a.isOrdered) ? 3 : (a.isOrdered ? 2 : 1);
      const statusB = (b.currentStock <= b.reorderLevel && !b.isOrdered) ? 3 : (b.isOrdered ? 2 : 1);
      return statusB - statusA;
    });


    return list;
  }, [inventory, searchTerm, filterLowStock]);

  if (!isAuthReady || loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-xl font-semibold text-gray-700">Loading Inventory...</div>
      </div>
    );
  }


  // --- Components ---

  const InventoryForm = ({ item, onSave, onClose }) => {
    const [name, setName] = useState(item?.name || '');
    const [stock, setStock] = useState(item?.currentStock || '');
    const [reorderLevel, setReorderLevel] = useState(item?.reorderLevel || '');
    const [unit, setUnit] = useState(item?.unit || 'kg');
    const [cost, setCost] = useState(item?.unitCost || '');
    const [vendor, setVendor] = useState(item?.primaryVendor || '');
    const [vendorContact, setVendorContact] = useState(item?.vendorContact || '');
    const [expectedDelivery, setExpectedDelivery] = useState(
      item?.expectedDelivery ? formatDateForInput(item.expectedDelivery) : ''
    );

    function formatDateForInput(timestamp) {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return date.toISOString().split('T')[0];
    }

    const handleSubmit = (e) => {
      e.preventDefault();
      onSave({ name, stock, reorderLevel, unit, cost, vendor, vendorContact, expectedDelivery });
    };

    return (
      <form onSubmit={handleSubmit} className="p-6 bg-white rounded-lg shadow-2xl">
        <h3 className="text-2xl font-bold mb-4 text-gray-800 border-b pb-2">{item ? 'Edit Inventory Item' : 'Add New Ingredient'}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-gray-700 text-sm font-medium">Ingredient Name*</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>
          <label className="block">
            <span className="text-gray-700 text-sm font-medium">Unit (kg/L)*</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 bg-white">
              <option value="kg">Kilograms (kg)</option>
              <option value="L">Liters (L)</option>
              <option value="pcs">Pieces (pcs)</option>
              <option value="case">Case</option>
              <option value="box">Box</option>
            </select>
          </label>
          <label className="block">
            <span className="text-gray-700 text-sm font-medium">Current Stock*</span>
            <input type="number" value={stock} onChange={(e) => setStock(e.target.value)} required min="0" step="0.01" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>
          <label className="block">
            <span className="text-gray-700 text-sm font-medium">Reorder Level* (Min Stock)</span>
            <input type="number" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} required min="0" step="0.01" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>
          <label className="block">
            <span className="text-gray-700 text-sm font-medium">Unit Cost (ETB)*</span>
            <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} required min="0" step="0.01" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>
          <label className="block">
            <span className="text-gray-700 text-sm font-medium">Primary Vendor</span>
            <input type="text" value={vendor} onChange={(e) => setVendor(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>
          <label className="block md:col-span-2">
            <span className="text-gray-700 text-sm font-medium">Vendor Contact (Phone/Email)</span>
            <input type="text" value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>

          {item && item.isOrdered && (
            <label className="block md:col-span-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <span className="text-blue-700 text-sm font-medium">Expected Delivery Date</span>
                <input type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
            </label>
          )}

        </div>
        <div className="mt-6 flex justify-end space-x-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition duration-150">
            Cancel
          </button>
          <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 shadow-md transition duration-150">
            {item ? 'Save Changes' : 'Add Item'}
          </button>
        </div>
      </form>
    );
  };


  const MarkOrderedModal = ({ item, onMark, onClose }) => {
    const [deliveryDate, setDeliveryDate] = useState('');

    const handleSubmit = (e) => {
      e.preventDefault();
      if (deliveryDate) {
        onMark(item, deliveryDate);
        onClose();
      }
    };

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <form onSubmit={handleSubmit} className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-sm">
          <h3 className="text-xl font-bold text-gray-800 mb-4 border-b pb-2">Mark "{item.name}" as Ordered</h3>
          <p className="text-sm text-gray-600 mb-4">Please set the expected delivery date for this urgent order. This will temporarily stop the AI from recommending it.</p>
          <label className="block mb-4">
            <span className="text-gray-700 text-sm font-medium">Expected Delivery Date</span>
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2" />
          </label>
          <div className="flex justify-end space-x-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition duration-150">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow-md transition duration-150">
              Confirm Order Placed
            </button>
          </div>
        </form>
      </div>
    );
  };

  const ReorderAnalysisModal = ({ analysis, isAnalyzing, onClose }) => (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-y-auto">
        <h3 className="text-2xl font-bold text-gray-800 mb-4 border-b pb-2">AI Supply Chain Analyst Report</h3>
        {isAnalyzing ? (
          <div className="flex items-center space-x-2 text-blue-600">
            <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p>Analyzing inventory and generating plan...</p>
          </div>
        ) : (
          <p className="text-gray-700 whitespace-pre-line leading-relaxed">{analysis}</p>
        )}
        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="px-6 py-2 text-sm font-medium text-white bg-gray-600 rounded-lg hover:bg-gray-700 transition duration-150">
            Close Report
          </button>
        </div>
      </div>
    </div>
  );


  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <header className="bg-white shadow-md p-4 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <h1 className="text-3xl font-extrabold text-indigo-700">Amen Bar and Restaurant</h1>
          <button
            onClick={() => {
              setCurrentItem(null);
              setIsModalOpen(true);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg shadow-lg hover:bg-indigo-700 transition duration-150 flex items-center"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" />
            </svg>
            Add New Item
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-8">
        {/* Management Actions */}
        <div className="mb-8 flex flex-col md:flex-row justify-between items-center bg-white p-6 rounded-xl shadow-lg border border-gray-200">
          <div className="mb-4 md:mb-0">
            <h2 className="text-xl font-semibold text-gray-800">Supply Chain Control Panel</h2>
            <p className="text-sm text-gray-500">Analyze current stock and generate intelligent reorder plans.</p>
          </div>
          <button
            onClick={handleGenerateAnalysis}
            disabled={isAnalyzing}
            className={`px-6 py-3 text-white rounded-full shadow-xl transition duration-150 ${
              isAnalyzing ? 'bg-orange-400 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-700'
            } flex items-center`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 2a8 8 0 100 16 8 8 0 000-16zM5 8a1 1 0 011-1h1.586l1.293-1.293A1 1 0 0110 5.414V7h1a1 1 0 110 2H6a1 1 0 01-1-1zM15 12a1 1 0 01-1 1h-1.586l-1.293 1.293A1 1 0 0110 14.586V13H9a1 1 0 110-2h5a1 1 0 011 1z" />
            </svg>
            {isAnalyzing ? 'Analyzing...' : 'Generate Reorder Plan'}
          </button>
        </div>

        {/* Search and Filter */}
        <div className="mb-6 bg-white p-4 rounded-xl shadow-md border border-gray-200 flex flex-col md:flex-row justify-between items-center space-y-3 md:space-y-0">
          <input
            type="text"
            placeholder="Search by Ingredient or Vendor..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full md:w-2/3 rounded-lg border-gray-300 shadow-sm p-3 focus:ring-indigo-500 focus:border-indigo-500"
          />
          <label className="flex items-center space-x-2 text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={filterLowStock}
              onChange={(e) => setFilterLowStock(e.target.checked)}
              className="h-5 w-5 text-red-600 rounded border-gray-300 focus:ring-red-500"
            />
            <span className="font-medium text-sm md:text-base">Show Only Urgent Items</span>
          </label>
        </div>

        {/* Inventory Table */}
        <div className="overflow-x-auto shadow-xl rounded-xl">
          <table className="min-w-full divide-y divide-gray-200 bg-white">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/4">Ingredient</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Stock</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">Reorder Level</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider hidden md:table-cell">Unit Cost</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Stock Value</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden lg:table-cell">Vendor</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredInventory.length > 0 ? (
                filteredInventory.map((item) => {
                  const isLow = item.currentStock <= item.reorderLevel;
                  const totalValue = item.currentStock * item.unitCost;
                  let status = 'Well Stocked';
                  let statusColor = 'text-green-600 bg-green-100';

                  if (isLow && !item.isOrdered) {
                    status = 'Urgent Reorder';
                    statusColor = 'text-red-600 bg-red-100';
                  } else if (item.isOrdered) {
                    status = 'Order Placed';
                    statusColor = 'text-blue-600 bg-blue-100';
                  }

                  return (
                    <tr key={item.id} className="hover:bg-gray-50 transition duration-150">
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{item.name}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}`}>
                          {status}
                        </span>
                        {item.isOrdered && item.expectedDelivery && (
                           <p className="text-xs text-blue-500 mt-1">
                             Delivery: {formatDate(item.expectedDelivery)}
                           </p>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500">{item.currentStock} {item.unit}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 hidden sm:table-cell">{item.reorderLevel} {item.unit}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 hidden md:table-cell">{formatCurrency(item.unitCost)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-semibold text-gray-900">{formatCurrency(totalValue)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-left text-sm text-gray-500 hidden lg:table-cell">{item.primaryVendor}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex justify-end space-x-1">
                          <button
                            onClick={() => {
                              setCurrentItem(item);
                              setIsModalOpen(true);
                            }}
                            className="text-indigo-600 hover:text-indigo-900 p-1 rounded-md"
                            title="Edit Item"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zm-5.045 9.172l-1.414 1.414L3 17.071V14.243l6.364-6.364 1.414 1.414-6.364 6.364z" />
                            </svg>
                          </button>
                           {isLow && !item.isOrdered && (
                              <button
                                onClick={() => setCurrentItem({ ...item, isMarkingOrdered: true })}
                                className="text-blue-600 hover:text-blue-900 p-1 rounded-md"
                                title="Mark as Ordered"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                  <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                                  <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v3h-3.328a.25.25 0 00-.176.429l1.408 1.407A1 1 0 0114 10.172V14a2 2 0 01-2 2H8a2 2 0 01-2-2v-3.828a1 1 0 01.352-.748l1.408-1.407A.25.25 0 008.328 8H5V5z" clipRule="evenodd" />
                                </svg>
                              </button>
                            )}

                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="text-red-600 hover:text-red-900 p-1 rounded-md"
                            title="Delete Item"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 10-2 0v6a1 1 0 102 0V8z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="8" className="text-center py-6 text-gray-500 text-lg">
                    {loading ? 'Loading inventory...' : 'No inventory items found. Click "Add New Item" to begin.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {/* Modals */}
      {(isModalOpen || (currentItem && !isModalOpen && !currentItem.isMarkingOrdered)) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <InventoryForm
              item={currentItem}
              onSave={handleSaveItem}
              onClose={() => {
                setIsModalOpen(false);
                setCurrentItem(null);
              }}
            />
          </div>
        </div>
      )}

      {currentItem && currentItem.isMarkingOrdered && (
         <MarkOrderedModal
            item={currentItem}
            onMark={handleMarkAsOrdered}
            onClose={() => setCurrentItem(null)}
         />
      )}

      {isAnalysisModalOpen && (
        <ReorderAnalysisModal
          analysis={analysisResult}
          isAnalyzing={isAnalyzing}
          onClose={() => setIsAnalysisModalOpen(false)}
        />
      )}
      <footer className="p-4 text-center text-xs text-gray-400">
          User ID: {userId} - Data Path: /artifacts/{appId}/users/{userId}/inventory
      </footer>
    </div>
  );
};

export default App;// Final fix attempt
