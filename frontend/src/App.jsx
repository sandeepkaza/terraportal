import { useState, useEffect } from 'react'

const API = import.meta.env.VITE_API_URL || 'https://ca-terraportal-prod-backend.agreeableground-f61d57af.eastus.azurecontainerapps.io'

const RESOURCE_TYPES = [
  { id: 'vm',       label: 'Virtual Machine',  icon: '🖥️' },
  { id: 'storage',  label: 'Storage Account',  icon: '🗄️' },
  { id: 'aks',      label: 'AKS Cluster',      icon: '☸️' },
  { id: 'sql',      label: 'SQL Database',     icon: '🗃️' },
  { id: 'keyvault', label: 'Key Vault',        icon: '🔑' },
  { id: 'vnet',     label: 'Virtual Network',  icon: '🌐' },
]

const REGIONS = ['East US','East US 2','West US','West US 2','West Europe','North Europe','Southeast Asia','Australia East','UK South','Canada Central']

const FIELDS = {
  vm:       [{ name:'name', label:'VM Name', required:true }, { name:'location', label:'Region', type:'select', options:REGIONS, required:true }, { name:'vmSize', label:'VM Size', type:'select', options:['Standard_B2s','Standard_D2s_v3','Standard_D4s_v3','Standard_E4s_v3'] }, { name:'adminUsername', label:'Admin Username', placeholder:'azureuser' }, { name:'diskType', label:'Disk Type', type:'select', options:['Standard_LRS','Premium_LRS','StandardSSD_LRS'] }, { name:'osDiskSizeGb', label:'Disk Size GB', type:'number', placeholder:'30' }],
  storage:  [{ name:'name', label:'Account Name', required:true }, { name:'location', label:'Region', type:'select', options:REGIONS, required:true }, { name:'tier', label:'Tier', type:'select', options:['Standard','Premium'] }, { name:'replication', label:'Replication', type:'select', options:['LRS','GRS','ZRS','RAGRS'] }, { name:'versioning', label:'Versioning', type:'select', options:['true','false'] }, { name:'retentionDays', label:'Retention Days', type:'number', placeholder:'7' }],
  aks:      [{ name:'name', label:'Cluster Name', required:true }, { name:'location', label:'Region', type:'select', options:REGIONS, required:true }, { name:'nodeCount', label:'Node Count', type:'number', placeholder:'3' }, { name:'vmSize', label:'Node VM Size', type:'select', options:['Standard_D2s_v3','Standard_D4s_v3','Standard_D8s_v3'] }, { name:'k8sVersion', label:'K8s Version', placeholder:'1.28.0' }],
  sql:      [{ name:'name', label:'Server Name', required:true }, { name:'location', label:'Region', type:'select', options:REGIONS, required:true }, { name:'adminLogin', label:'Admin Login', placeholder:'sqladmin' }, { name:'sku', label:'SKU', type:'select', options:['Basic','S0','S1','S2','P1'] }, { name:'maxSizeGb', label:'Max Size GB', type:'number', placeholder:'32' }],
  keyvault: [{ name:'name', label:'Vault Name', required:true }, { name:'location', label:'Region', type:'select', options:REGIONS, required:true }, { name:'softDeleteRetention', label:'Soft Delete Days', type:'number', placeholder:'90' }, { name:'networkDefaultAction', label:'Network Default', type:'select', options:['Allow','Deny'] }],
  vnet:     [{ name:'name', label:'VNet Name', required:true }, { name:'location', label:'Region', type:'select', options:REGIONS, required:true }, { name:'addressSpace', label:'Address Space', placeholder:'10.0.0.0/16' }],
}

export default function App() {
  const [view, setView] = useState('provision')
  const [inventory, setInventory] = useState([])
  const [history, setHistory] = useState([])
  const [resourceType, setResourceType] = useState('vnet')
  const [form, setForm] = useState({ ticket:'', environment:'prod', requestedBy:'' })
  const [provisioning, setProvisioning] = useState(false)
  const [message, setMessage] = useState(null)
  const [selected, setSelected] = useState(null)

  useEffect(() => { loadInventory() }, [])

  async function loadInventory() {
    try {
      const r = await fetch(`${API}/api/inventory`)
      const d = await r.json()
      setInventory(d.resources || [])
    } catch(e) { console.error('API error:', e) }
  }

  async function loadHistory() {
    try {
      const r = await fetch(`${API}/api/history`)
      const d = await r.json()
      setHistory(d.history || [])
    } catch(e) {}
  }

  async function provision() {
    if (!form.ticket || !form.name) return setMessage({ type:'error', text:'Ticket and resource name are required' })
    setProvisioning(true)
    setMessage({ type:'info', text:'Provisioning started...' })
    try {
      const res = await fetch(`${API}/api/provision`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          resourceType,
          config: form,
          ticket: form.ticket,
          environment: form.environment || 'prod',
          requestedBy: form.requestedBy || 'anonymous',
        })
      })
      const d = await res.json()
      if (res.ok) {
        setMessage({ type:'success', text:`✓ Provisioning started! Deployment ID: ${d.deploymentId}` })
        setTimeout(loadInventory, 3000)
      } else {
        setMessage({ type:'error', text:`Error: ${d.error || 'Unknown error'}` })
      }
    } catch(e) {
      setMessage({ type:'error', text:`Network error: ${e.message}` })
    }
    setProvisioning(false)
  }

  async function decommission(id, name) {
    if (!window.confirm(`Type the resource name to confirm decommission:\n\n${name}`)) return
    try {
      await fetch(`${API}/api/resources/${id}`, { method:'DELETE' })
      setMessage({ type:'success', text:`Decommission started for ${name}` })
      loadInventory()
    } catch(e) {}
  }

  const stats = {
    deployed: inventory.filter(r=>r.status==='deployed').length,
    provisioning: inventory.filter(r=>r.status==='provisioning').length,
    failed: inventory.filter(r=>r.status==='failed').length,
    decommissioned: inventory.filter(r=>r.status==='decommissioned').length,
  }

  const fields = FIELDS[resourceType] || []

  return (
    <div style={{fontFamily:"'IBM Plex Mono',monospace",background:'#0d1117',color:'#c9d1d9',minHeight:'100vh'}}>
      {/* Header */}
      <div style={{background:'#161b22',borderBottom:'1px solid #21262d',padding:'0 20px',height:56,display:'flex',alignItems:'center',gap:16,position:'sticky',top:0,zIndex:200}}>
        <span style={{fontSize:20}}>⚡</span>
        <span style={{fontSize:17,fontWeight:700,color:'#58a6ff'}}>TerraPortal</span>
        <span style={{fontSize:10,color:'#8b949e',borderLeft:'1px solid #30363d',paddingLeft:12}}>v2 · Azure Lifecycle Manager</span>
        <div style={{flex:1,display:'flex',gap:16,justifyContent:'center',fontSize:12}}>
          <span><b style={{color:'#3fb950'}}>{stats.deployed}</b> deployed</span>
          <span><b style={{color:'#f0883e'}}>{stats.provisioning}</b> provisioning</span>
          <span><b style={{color:'#f85149'}}>{stats.failed}</b> failed</span>
          <span><b style={{color:'#8b949e'}}>{stats.decommissioned}</b> decommissioned</span>
        </div>
        <div style={{display:'flex',gap:4}}>
          {['provision','resources','history'].map(v=>(
            <button key={v} onClick={()=>{ setView(v); if(v==='history') loadHistory() }} style={{background:view===v?'#1f6feb22':'transparent',border:`1px solid ${view===v?'#1f6feb':'transparent'}`,color:view===v?'#58a6ff':'#8b949e',padding:'5px 13px',borderRadius:6,cursor:'pointer',fontSize:11,fontFamily:'inherit'}}>
              {v==='provision'?'🚀 Provision':v==='resources'?`📦 Resources (${inventory.length})`:'📋 History'}
            </button>
          ))}
        </div>
      </div>

      <main style={{padding:20,maxWidth:1400,margin:'0 auto'}}>

        {/* Message */}
        {message && (
          <div style={{marginBottom:16,padding:'10px 16px',borderRadius:6,background:message.type==='error'?'#3d1a1a':message.type==='success'?'#1a3d2a':'#1a2a3d',border:`1px solid ${message.type==='error'?'#f85149':message.type==='success'?'#3fb950':'#58a6ff'}`,color:message.type==='error'?'#f85149':message.type==='success'?'#3fb950':'#58a6ff',fontSize:12}}>
            {message.text} <span onClick={()=>setMessage(null)} style={{float:'right',cursor:'pointer'}}>✕</span>
          </div>
        )}

        {/* Provision View */}
        {view==='provision' && (
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
            <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:10,padding:20}}>
              <div style={{fontSize:16,fontWeight:700,color:'#e6edf3',marginBottom:18}}>🚀 Provision New Resource</div>

              {/* Resource Type */}
              <div style={{marginBottom:16}}>
                <div style={{fontSize:10,color:'#8b949e',textTransform:'uppercase',letterSpacing:'.5px',marginBottom:8}}>Resource Type</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
                  {RESOURCE_TYPES.map(rt=>(
                    <button key={rt.id} onClick={()=>setResourceType(rt.id)} style={{background:resourceType===rt.id?'#1f6feb22':'#0d1117',border:`1px solid ${resourceType===rt.id?'#1f6feb':'#30363d'}`,borderRadius:7,padding:'10px 6px',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:3,fontFamily:'inherit',color:resourceType===rt.id?'#e6edf3':'#8b949e',fontSize:11}}>
                      <span style={{fontSize:18}}>{rt.icon}</span>{rt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Request Details */}
              <div style={{marginBottom:16}}>
                <div style={{fontSize:10,color:'#8b949e',textTransform:'uppercase',letterSpacing:'.5px',marginBottom:8}}>Request Details</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                  <div>
                    <div style={{fontSize:10,color:'#6b7280',marginBottom:3}}>Ticket *</div>
                    <input value={form.ticket||''} onChange={e=>setForm({...form,ticket:e.target.value})} placeholder="JIRA-1234" style={{width:'100%',background:'#0d1117',border:'1px solid #30363d',borderRadius:5,color:'#e6edf3',padding:'7px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}}/>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:'#6b7280',marginBottom:3}}>Environment</div>
                    <select value={form.environment||'prod'} onChange={e=>setForm({...form,environment:e.target.value})} style={{width:'100%',background:'#0d1117',border:'1px solid #30363d',borderRadius:5,color:'#e6edf3',padding:'7px 10px',fontSize:12,fontFamily:'inherit',outline:'none'}}>
                      {['dev','staging','prod','dr'].map(e=><option key={e}>{e}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:'#6b7280',marginBottom:3}}>Requested By</div>
                    <input value={form.requestedBy||''} onChange={e=>setForm({...form,requestedBy:e.target.value})} placeholder="your.name" style={{width:'100%',background:'#0d1117',border:'1px solid #30363d',borderRadius:5,color:'#e6edf3',padding:'7px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}}/>
                  </div>
                </div>
              </div>

              {/* Resource Fields */}
              <div style={{marginBottom:16}}>
                <div style={{fontSize:10,color:'#8b949e',textTransform:'uppercase',letterSpacing:'.5px',marginBottom:8}}>Configuration</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                  {fields.map(f=>(
                    <div key={f.name}>
                      <div style={{fontSize:10,color:'#6b7280',marginBottom:3}}>{f.label}{f.required?' *':''}</div>
                      {f.type==='select'
                        ? <select value={form[f.name]||''} onChange={e=>setForm({...form,[f.name]:e.target.value})} style={{width:'100%',background:'#0d1117',border:'1px solid #30363d',borderRadius:5,color:'#e6edf3',padding:'7px 10px',fontSize:12,fontFamily:'inherit',outline:'none'}}>
                            <option value="">Select...</option>
                            {f.options.map(o=><option key={o}>{o}</option>)}
                          </select>
                        : <input type={f.type||'text'} value={form[f.name]||''} onChange={e=>setForm({...form,[f.name]:e.target.value})} placeholder={f.placeholder||''} style={{width:'100%',background:'#0d1117',border:'1px solid #30363d',borderRadius:5,color:'#e6edf3',padding:'7px 10px',fontSize:12,fontFamily:'inherit',outline:'none',boxSizing:'border-box'}}/>
                      }
                    </div>
                  ))}
                </div>
              </div>

              <button onClick={provision} disabled={provisioning} style={{width:'100%',background:provisioning?'#1f6feb88':'#1f6feb',border:'none',borderRadius:6,color:'#fff',padding:'10px',fontSize:13,fontFamily:'inherit',cursor:provisioning?'not-allowed':'pointer',fontWeight:600}}>
                {provisioning ? '⏳ Provisioning...' : '🚀 Provision with Terraform'}
              </button>
            </div>

            {/* Right panel */}
            <div style={{display:'flex',flexDirection:'column',gap:16}}>
              <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:10,padding:20}}>
                <div style={{fontSize:14,fontWeight:700,color:'#e6edf3',marginBottom:12}}>☁️ Terraform State — Azure Blob</div>
                <div style={{fontSize:11,color:'#8b949e',lineHeight:2}}>
                  <div>🟠 Storage: <span style={{color:'#f0883e'}}>terraportalstate</span></div>
                  <div>📦 Container: <span style={{color:'#58a6ff'}}>tfstate</span></div>
                  <div>🔑 State Key: <span style={{color:'#58a6ff'}}>&lt;deployment_id&gt;/terraform.tfstate</span></div>
                  <div>📋 Inventory: <span style={{color:'#58a6ff'}}>inventory/inventory.json</span></div>
                </div>
                <div style={{marginTop:12,padding:'8px 12px',background:'#1a3d2a',border:'1px solid #3fb950',borderRadius:6,fontSize:11,color:'#3fb950'}}>
                  Each resource has its own isolated state file.
                </div>
              </div>
              <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:10,padding:20}}>
                <div style={{fontSize:14,fontWeight:700,color:'#e6edf3',marginBottom:12}}>🏷️ Auto-applied Tags</div>
                {['ticket','environment','managed_by','deployment_id','created_at'].map(t=>(
                  <div key={t} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0',borderBottom:'1px solid #21262d'}}>
                    <span style={{background:'#21262d',padding:'2px 6px',borderRadius:3,color:'#8b949e'}}>{t}</span>
                    <span style={{color:'#58a6ff'}}>{t==='ticket'?form.ticket||'—':t==='environment'?form.environment||'prod':t==='managed_by'?'terraform-portal':t==='deployment_id'?'auto-generated':'auto'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Resources View */}
        {view==='resources' && (
          <div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <div style={{fontSize:16,fontWeight:700,color:'#e6edf3'}}>📦 Resource Inventory</div>
              <button onClick={loadInventory} style={{background:'#21262d',border:'1px solid #30363d',color:'#8b949e',padding:'5px 12px',borderRadius:6,cursor:'pointer',fontSize:11,fontFamily:'inherit'}}>↻ Refresh</button>
            </div>
            {inventory.length === 0
              ? <div style={{textAlign:'center',padding:40,color:'#8b949e',fontSize:13}}>No resources yet. Provision one!</div>
              : inventory.map(r=>(
                <div key={r.id} style={{background:'#161b22',border:'1px solid #30363d',borderRadius:10,padding:16,marginBottom:12}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <span style={{fontSize:18}}>{RESOURCE_TYPES.find(t=>t.id===r.resourceType)?.icon||'📦'}</span>
                      <div>
                        <div style={{fontSize:14,fontWeight:700,color:'#e6edf3'}}>{r.name || r.config?.name || r.id}</div>
                        <div style={{fontSize:11,color:'#8b949e'}}>{r.resourceType} · {r.environment} · {r.id}</div>
                      </div>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{padding:'3px 10px',borderRadius:20,fontSize:11,background:r.status==='deployed'?'#1a3d2a':r.status==='provisioning'?'#2a1a3d':r.status==='failed'?'#3d1a1a':'#21262d',color:r.status==='deployed'?'#3fb950':r.status==='provisioning'?'#a371f7':r.status==='failed'?'#f85149':'#8b949e'}}>
                        {r.status}
                      </span>
                      {r.status==='deployed' && (
                        <button onClick={()=>decommission(r.id, r.name||r.config?.name)} style={{background:'transparent',border:'1px solid #f85149',color:'#f85149',padding:'3px 10px',borderRadius:5,cursor:'pointer',fontSize:11,fontFamily:'inherit'}}>
                          🗑️ Decommission
                        </button>
                      )}
                    </div>
                  </div>
                  {r.logs && r.logs.length > 0 && (
                    <div style={{background:'#0d1117',borderRadius:5,padding:'8px 10px',fontSize:10,color:'#8b949e',maxHeight:80,overflow:'auto',fontFamily:'monospace'}}>
                      {r.logs.slice(-3).map((l,i)=><div key={i}>{l}</div>)}
                    </div>
                  )}
                </div>
              ))
            }
          </div>
        )}

        {/* History View */}
        {view==='history' && (
          <div>
            <div style={{fontSize:16,fontWeight:700,color:'#e6edf3',marginBottom:16}}>📋 Audit History</div>
            {history.length === 0
              ? <div style={{textAlign:'center',padding:40,color:'#8b949e',fontSize:13}}>No history yet.</div>
              : history.map(h=>(
                <div key={h.id} style={{background:'#161b22',border:'1px solid #30363d',borderRadius:8,padding:12,marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <span style={{padding:'2px 8px',borderRadius:3,fontSize:10,fontWeight:700,marginRight:8,background:h.action==='provision'?'#1a3d2a':h.action==='decommission'?'#3d1a1a':'#1a2a3d',color:h.action==='provision'?'#3fb950':h.action==='decommission'?'#f85149':'#58a6ff'}}>
                      {h.action?.toUpperCase()}
                    </span>
                    <span style={{fontSize:12,color:'#e6edf3'}}>{h.deploymentId}</span>
                    <span style={{fontSize:11,color:'#8b949e',marginLeft:8}}>by {h.actor}</span>
                  </div>
                  <div style={{fontSize:11,color:'#8b949e'}}>{new Date(h.timestamp).toLocaleString()}</div>
                </div>
              ))
            }
          </div>
        )}

      </main>
    </div>
  )
}
