import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL || 'https://ca-terraportal-prod-backend.agreeableground-f61d57af.eastus.azurecontainerapps.io'

export default function App() {
  const [inventory, setInventory] = useState([])

  useEffect(() => {
    fetch(`${API}/api/inventory`)
      .then(r => r.json())
      .then(d => setInventory(d.resources || []))
      .catch(() => {})
  }, [])

  return (
    <div style={{fontFamily:'sans-serif',padding:'2rem'}}>
      <h1>TerraPortal v2</h1>
      <p>Azure Infrastructure Lifecycle Manager</p>
      <h2>Resources ({inventory.length})</h2>
      {inventory.map(r => <div key={r.id}>{r.name} — {r.type}</div>)}
    </div>
  )
}
