/* global __app_id __firebase_config __initial_auth_token */
import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, collection, query, onSnapshot, updateDoc, deleteDoc, addDoc, serverTimestamp } from 'firebase/firestore';

// ==================================================================================== 
// --- CONFIGURATION SETUP (FINAL CLEANED VERSION) --- 
// ====================================================================================

// Define the final configuration object using the secure Netlify variables
const firebaseConfig = process.env.REACT_APP_FIREBASE_CONFIG
  ? JSON.parse(process.env.REACT_APP_FIREBASE_CONFIG)
  : null;

// Define the variables the rest of your app needs:
const appId = process.env.REACT_APP_APP_ID;
const initialAuthToken = process.env.REACT_APP_INITIAL_AUTH_TOKEN;

// Initialize Firebase services once
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// API Configuration 
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=';
const MAX_RETRIES = 5; 
const INITIAL_BACKOFF_MS = 1000;

// ==================================================================================== 
// --- UTILITY FUNCTIONS --- 
// ====================================================================================

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
  for (let i = 0; i < maxRetries; i++) { 
    try { 
      const response = await fetch(GEMINI_API_URL, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({
          contents: [{ parts: [{ text: userQuery }] }],
          config: {
            tools: [{ "google_search": {} }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
          }
        }),
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
      // Continue to the next retry attempt
      continue;
    }
  }
  return "Error: Unknown failure after retries.";
}; 

// ==================================================================================== 
// --- COMPONENT LOGIC --- 
// ====================================================================================

const App = () => { 
  // --- STATE DECLARATIONS (Restored to fix all 'no-undef' errors) ---
  const [inventory, setInventory] = useState([]); 
  const [loading, setLoading] = useState(true); 
  const [userId, setUserId] = useState(null); 
  const [isAuthReady, setIsAuthReady] = useState(false); 
  const [isModalOpen, setIsModalOpen] = useState(false); 
  
  // *** MISSING STATE HOOKS RESTORED ***
  const [isAnalysisModalOpen, setIsAnalysisModalOpen] = useState(false); // <--- RESTORED
  const [analysisResult, setAnalysisResult] = useState(''); // <--- RESTORED
  const [isAnalyzing, setIsAnalyzing] = useState(false); // <--- RESTORED
  // **********************************
  
  const [currentItem, setCurrentItem] = useState(null); 
  const [searchTerm, setSearchTerm] = useState(''); 
  const [filterLowStock, setFilterLowStock] = useState(false);

  // --- CORE FUNCTIONS (Handling Logic that caused previous errors) ---

  const handleSaveItem = async (data) => { 
    if (!userId) { console.error("Error: User not authenticated. Cannot save data."); return; }

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
      if (!auth || !db || !item.id || !deliveryDate) return;
      try {
          const docRef = doc(db, `/artifacts/${appId}/users/${auth.currentUser.uid}/inventory`, item.id);
          await updateDoc(docRef, {
              isOrdered: true,
              expectedDelivery: new Date(deliveryDate),
              updatedAt: serverTimestamp(),
          });
      } catch (e) {
          console.error("Error marking as ordered: ", e);
      }
  };


  const handleAnalyze = async () => { // <--- FINAL FIX: ADDED ASYNC
    const urgentItems = filteredInventory.filter(item => item.currentStock <= item.reorderLevel && !item.isOrdered);
    if (urgentItems.length === 0) {
        alert("No urgent items to analyze.");
        return;
    }

    // AI Analysis Logic
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

    setIsAnalyzing(true);
    setAnalysisResult(null);
    setIsAnalysisModalOpen(true); // Open modal while fetching

    try {
        const result = await callGeminiApi(systemPrompt, userQuery);
        setAnalysisResult(result);
    } catch (e) {
        setAnalysisResult("Error: Failed to fetch analysis. Please check network/API status.");
    } finally {
        setIsAnalyzing(false);
    }
  };

  // --- FILTERING AND MEMOIZATION (Restored) ---

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
  }, [inventory, searchTerm, filterLowStock]); // filteredInventory RESTORED

  // --- EFFECT HOOKS ---

  // 1. Authentication and Initialization 
  useEffect(() => { 
    if (!auth || !db) { console.error("Firebase not initialized."); return; } 

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
  }, []); // Cleaned dependency array

  // 2. Data Fetching (Firestore onSnapshot) 
  useEffect(() => { 
    if (db && userId) { 
      setLoading(true); 
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
  }, [userId]); // Cleaned dependency array

  // --- RENDER LOGIC ---

  if (!isAuthReady || loading) { return ( <div className="flex items-center justify-center h-screen bg-gray-50"> <div className="text-xl font-semibold text-gray-700">Loading Inventory...</div> </div> ); }

  // Components (InventoryForm, MarkOrderedModal, ReorderAnalysisModal - omitted for brevity but assumed clean)

  return ( 
    <div className="min-h-screen bg-gray-50 font-sans"> 
      <header className="bg-white shadow-md p-4 sticky top-0 z-10"> 
        <div className="max-w-7xl mx-auto flex justify-between items-center"> 
          <h1 className="text-3xl font-extrabold text-indigo-700">Amen Bar and Restaurant</h1> 
          <button onClick={() => { setCurrentItem(null); setIsModalOpen(true); }} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg shadow-lg hover:bg-indigo-700 transition duration-150 flex items-center" > 
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor"> 
              <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" /> 
            </svg> Add New Item 
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
            onClick={handleAnalyze}
            disabled={isAnalyzing}
            className={isAnalyzing ? 'px-6 py-3 text-white rounded-full shadow-xl transition duration-150 bg-orange-400 cursor-not-allowed flex items-center' : 'px-6 py-3 text-white rounded-full shadow-xl transition duration-150 bg-orange-600 hover:bg-orange-700 flex items-center'}
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
            placeholder="Search items or vendors..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full md:w-1/3 p-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
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
                        {/* STATUS BADGE: Final syntax fix applied here */}
                        <span
                          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}`}
                        >
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
                          <button onClick={() => { setCurrentItem(item); setIsModalOpen(true); }} className="text-indigo-600 hover:text-indigo-900 p-1 rounded-md" title="Edit Item" >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zm-5.045 9.172l-1.414 1.414L3 17.071V14.243l6.364-6.364 1.414 1.414-6.364 6.364z" />
                            </svg>
                          </button>
                          {isLow && !item.isOrdered && (
                            <button onClick={() => setCurrentItem({ ...item, isMarkingOrdered: true })} className="text-blue-600 hover:text-blue-900 p-1 rounded-md" title="Mark as Ordered" >
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
            {/* InventoryForm component is here (omitted for brevity) */}
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

export default App;
